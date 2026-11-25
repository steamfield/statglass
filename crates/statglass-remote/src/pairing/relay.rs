//! Relays one phone's pairing exchange over the host's owner-only socket.
use super::{MAX_TTL, entropy_error, reject};
use crate::{ControlRequest, ControlResponse, RemoteError, control_request};
use p256::elliptic_curve::Generate;
use statglass_proto::pairing::{PAIR_RECEIPT_GRACE, PairError, PairReply, PairStart};
use statglass_session::pairing::{read_pair_frame, write_pair_frame};
use std::{path::Path, time::Duration};
use tokio::{
    io::{self, AsyncRead, AsyncWrite},
    time::{Instant, sleep_until, timeout, timeout_at},
};

const POLL_INTERVAL: Duration = Duration::from_secs(1);
const CONTROL_BUDGET: Duration = Duration::from_secs(9);
const ABANDON_BUDGET: Duration = Duration::from_secs(2);

/// Relays PairStart and polls PairStatus once a second. Returns 0 on approval and 2 otherwise.
pub async fn run_forced<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    stdin: R,
    stdout: W,
    control: &Path,
) -> i32 {
    run_relay(stdin, stdout, control, None).await
}

/// A forced command may relay only the offer named on its authorized_keys line.
pub async fn run_forced_for_nonce(
    stdin: impl AsyncRead + Unpin,
    stdout: impl AsyncWrite + Unpin,
    control: &Path,
    nonce: &str,
) -> i32 {
    run_relay(stdin, stdout, control, Some(nonce)).await
}

async fn run_relay(
    mut stdin: impl AsyncRead + Unpin,
    mut stdout: impl AsyncWrite + Unpin,
    control: &Path,
    forced_nonce: Option<&str>,
) -> i32 {
    let Ok(Ok(start)) = timeout(CONTROL_BUDGET, read_pair_frame::<PairStart>(&mut stdin)).await
    else {
        return 2;
    };
    if forced_nonce.is_some_and(|nonce| nonce != start.nonce) {
        let _ = write_pair_frame(&mut stdout, &reject(PairError::Unknown)).await;
        return 2;
    }
    let attempt = match <[u8; 16]>::try_generate() {
        Ok(attempt) => attempt,
        Err(error) => {
            let _ = write_pair_frame(&mut stdout, &reject(entropy_error(error))).await;
            return 2;
        }
    };
    let closed = ControlRequest::PairAbandon {
        nonce: start.nonce.clone(),
        attempt,
    };
    let mut discard = io::sink();
    let decision = tokio::select! {
        biased;
        // The phone holds stdin open until it receives a decision. An EOF or read
        // error ends the relay even while a control request has stalled.
        _ = io::copy(&mut stdin, &mut discard) => {
            abandon(control, &closed).await;
            return 2;
        }
        result = relay_decision(&mut stdout, control, start, attempt) => result,
    };
    let reply = match decision {
        Ok(Decision::Finish(reply)) => reply,
        Ok(Decision::Abandon(fallback)) => abandon(control, &closed).await.unwrap_or(fallback),
        Err(error) => {
            tracing::debug!(
                error = &error as &dyn std::error::Error,
                "sending pairing reply"
            );
            abandon(control, &closed).await;
            return 2;
        }
    };
    if let Err(error) = write_pair_frame(&mut stdout, &reply).await {
        tracing::debug!(
            error = &error as &dyn std::error::Error,
            "sending final pairing reply"
        );
        abandon(control, &closed).await;
        return 2;
    }
    if matches!(reply, PairReply::Approved { .. }) {
        0
    } else {
        2
    }
}

enum Decision {
    Finish(PairReply),
    Abandon(PairReply),
}

async fn relay_decision(
    stdout: &mut (impl AsyncWrite + Unpin),
    control: &Path,
    start: PairStart,
    attempt: [u8; 16],
) -> Result<Decision, RemoteError> {
    let status = ControlRequest::PairStatus {
        nonce: start.nonce.clone(),
    };
    let request = ControlRequest::PairStart { start, attempt };
    // Until the host reports its expiry, allow one initial control budget and
    // enough time to retry a start whose reply was lost.
    let start_deadline = Instant::now() + CONTROL_BUDGET + PAIR_RECEIPT_GRACE;
    let Some(response) = request_until(control, &request, start_deadline).await else {
        return Ok(Decision::Abandon(reject(PairError::Unavailable)));
    };
    match response.pairing {
        Some(PairReply::Waiting) => {
            let Some(expires_ms) = response.pairing_expires_ms else {
                return Ok(Decision::Abandon(reject(PairError::Unavailable)));
            };
            let remaining_ms = expires_ms
                .saturating_sub(statglass_engine::wall_ms())
                .max(0);
            let expiry = Instant::now() + Duration::from_millis(remaining_ms as u64).min(MAX_TTL);
            write_pair_frame(stdout, &PairReply::Waiting).await?;
            Ok(poll_decision(control, &status, expiry).await)
        }
        Some(PairReply::Pending { .. }) | None => {
            Ok(Decision::Abandon(reject(PairError::Unavailable)))
        }
        Some(reply) => Ok(Decision::Finish(reply)),
    }
}

async fn poll_decision(control: &Path, status: &ControlRequest, expiry: Instant) -> Decision {
    let receipt_deadline = expiry + PAIR_RECEIPT_GRACE;
    loop {
        sleep_until((Instant::now() + POLL_INTERVAL).min(expiry)).await;
        // At expiry, do one final read for a decision the host made just before
        // the deadline. Transport errors after expiry do not start another retry.
        let final_poll = Instant::now() >= expiry;
        match request_pairing(control, status, receipt_deadline)
            .await
            .and_then(|response| response.pairing)
        {
            Some(
                PairReply::Pending { .. }
                | PairReply::Error {
                    error: PairError::Unavailable,
                },
            ) => {
                return Decision::Abandon(reject(PairError::Unavailable));
            }
            Some(PairReply::Waiting) | None if final_poll => {
                return Decision::Abandon(PairReply::Expired);
            }
            Some(PairReply::Waiting) | None => {}
            Some(reply) => return Decision::Finish(reply),
        }
    }
}

async fn abandon(control: &Path, request: &ControlRequest) -> Option<PairReply> {
    let response = request_until(control, request, Instant::now() + ABANDON_BUDGET).await?;
    match response.pairing {
        reply @ Some(PairReply::Expired | PairReply::Denied | PairReply::Approved { .. }) => reply,
        _ => None,
    }
}

async fn request_until(
    control: &Path,
    request: &ControlRequest,
    deadline: Instant,
) -> Option<ControlResponse> {
    loop {
        if let Some(response) = request_pairing(control, request, deadline).await {
            return Some(response);
        }
        if Instant::now() >= deadline {
            return None;
        }
        sleep_until((Instant::now() + POLL_INTERVAL).min(deadline)).await;
    }
}

async fn request_pairing(
    control: &Path,
    request: &ControlRequest,
    deadline: Instant,
) -> Option<ControlResponse> {
    let now = Instant::now();
    if now >= deadline {
        return None;
    }
    match timeout_at(
        (now + CONTROL_BUDGET).min(deadline),
        control_request(control, request),
    )
    .await
    {
        Ok(Ok(response)) => Some(response),
        Ok(Err(error)) => {
            tracing::debug!(
                error = &error as &dyn std::error::Error,
                "contacting the pairing host"
            );
            None
        }
        Err(_) => None,
    }
}
