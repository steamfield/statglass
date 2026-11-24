//! The shared handshake and the race across an endpoint's targets, on top of any
//! [`Dialer`].
use crate::{
    DialFailure, DialedStream, Dialer, Endpoint, HandshakeFailure, RemoteError, Result, RouteError,
    SshSession, Target, marker_error,
};
use statglass_proto::{Hello, Message, Negotiated, Offer};
use statglass_schema::HostId;
use std::{
    future::{Future, pending, poll_fn},
    task::Poll,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    time::{Instant, sleep_until, timeout_at},
};

/// How long one target gets for its dial and StatGlass handshake, counted from the
/// dial start. Failed streams are closed before their error is classified.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// The dial and handshake budget in milliseconds, exposed to connection status.
pub const DIAL_TIMEOUT_MS: i64 = HANDSHAKE_TIMEOUT.as_millis() as i64;
/// How long a less-preferred success waits for a more-preferred target still pending.
pub const ROUTE_GRACE: Duration = Duration::from_millis(500);
/// How long after a network change a source waits before racing better routes.
pub const PROMOTION_DEBOUNCE: Duration = Duration::from_secs(2);

/// Dials every target of `endpoint` at once, runs the handshake on each stream and
/// returns the preferred session. `local` is this device's host id (a host answering
/// with it is this device); `expected` is the paired host's id, when known.
pub async fn connect(
    dialer: &dyn Dialer,
    endpoint: &Endpoint,
    local: HostId,
    expected: Option<HostId>,
) -> Result<SshSession> {
    endpoint.validate()?;
    if let [target] = endpoint.targets.as_slice() {
        return connect_target(dialer, endpoint, target, local, expected).await;
    }

    let mut attempts: Vec<_> = endpoint
        .targets
        .iter()
        .enumerate()
        .map(|(index, target)| {
            (
                index,
                target,
                Box::pin(connect_target(dialer, endpoint, target, local, expected)),
            )
        })
        .collect();
    let mut preferred: Option<(usize, SshSession)> = None;
    let mut failures = Vec::new();
    let mut grace = None;
    while !attempts.is_empty() {
        // Poll all targets together, including on the first turn. Keeping the futures
        // here makes returning from the race drop every unfinished attempt.
        let ready = poll_fn(|cx| {
            let mut ready = Vec::new();
            attempts.retain_mut(|(index, target, attempt)| match attempt.as_mut().poll(cx) {
                Poll::Ready(result) => {
                    ready.push((*index, *target, result));
                    false
                }
                Poll::Pending => true,
            });
            if ready.is_empty() {
                Poll::Pending
            } else {
                Poll::Ready(ready)
            }
        });
        let completed = tokio::select! {
            biased;
            completed = ready => completed,
            () = wait_for_grace(grace) => break,
        };
        for (index, target, result) in completed {
            match result {
                Err(error) if !error.retryable() => return Err(error),
                Err(error) => failures.push((
                    index,
                    RouteError {
                        route: target.route,
                        host: target.host.clone(),
                        error,
                    },
                )),
                Ok(session) => {
                    if let Some((_, best)) = &preferred
                        && best.hello.host.id != session.hello.host.id
                    {
                        return Err(conflicting_identity(&best.target, target));
                    }
                    if preferred.as_ref().is_none_or(|(best, _)| index < *best) {
                        preferred = Some((index, session));
                    }
                    grace.get_or_insert_with(|| Instant::now() + ROUTE_GRACE);
                }
            }
        }
        if let Some((best, _)) = &preferred
            && attempts.first().is_none_or(|(index, ..)| index > best)
        {
            break;
        }
    }
    preferred
        .map(|(_, session)| session)
        .ok_or_else(|| route_error(failures))
}

async fn wait_for_grace(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => sleep_until(deadline).await,
        None => pending().await,
    }
}

fn conflicting_identity(first: &Target, second: &Target) -> RemoteError {
    let detail = if first.route == second.route {
        format!(
            "{} and {} identify different hosts",
            first.host, second.host
        )
    } else {
        "LAN and Tailscale identify different Macs".into()
    };
    RemoteError::Identity(detail)
}

fn route_error(mut failures: Vec<(usize, RouteError)>) -> RemoteError {
    failures.sort_unstable_by_key(|(index, _)| *index);
    let routes: Vec<_> = failures.into_iter().map(|(_, failure)| failure).collect();
    let agent_not_running = routes
        .iter()
        .any(|failure| matches!(failure.error, RemoteError::AgentNotRunning(_)));
    let error = RemoteError::Routes(routes);
    if agent_not_running {
        RemoteError::AgentNotRunning(error.to_string())
    } else {
        error
    }
}

async fn connect_target(
    dialer: &dyn Dialer,
    endpoint: &Endpoint,
    target: &Target,
    local: HostId,
    expected: Option<HostId>,
) -> Result<SshSession> {
    let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
    let mut stream = timeout_at(deadline, dialer.dial(endpoint, target))
        .await
        .map_err(|_| {
            RemoteError::Timeout(format!(
                "{}: {}",
                target.host,
                HandshakeFailure::TimedOut.sentence()
            ))
        })??;
    let hello = match timeout_at(deadline, read_hello(&mut stream.reader))
        .await
        .unwrap_or(Err(HandshakeFailure::TimedOut))
    {
        Ok(hello) => *hello,
        Err(outcome) => {
            return Err(classify_greeting_failure(dialer, target, stream, outcome).await);
        }
    };
    let handshake = async {
        let negotiated = negotiate(&hello, target, local, expected)?;
        timeout_at(deadline, write_ack(&mut stream.writer, &negotiated))
            .await
            .map_err(|_| RemoteError::Transport("peer stopped reading".into()))??;
        Ok(negotiated)
    }
    .await;
    match handshake {
        Ok(negotiated) => Ok(SshSession::new(hello, negotiated, target.clone(), stream)),
        Err(error) => {
            stream.close.close().await;
            Err(error)
        }
    }
}

async fn classify_greeting_failure(
    dialer: &dyn Dialer,
    target: &Target,
    stream: DialedStream,
    outcome: HandshakeFailure,
) -> RemoteError {
    stream.close.close().await;
    tokio::task::yield_now().await;
    let stderr = stream.stderr.text();
    tracing::debug!(?outcome, %stderr, host = %target.host, "remote handshake failed");
    marker_error(target, &stderr).unwrap_or_else(|| {
        dialer.classify(&DialFailure {
            target,
            stderr: &stderr,
            outcome,
        })
    })
}

fn negotiate(
    hello: &Hello,
    target: &Target,
    local: HostId,
    expected: Option<HostId>,
) -> Result<Negotiated> {
    if hello.host.id == local {
        return Err(RemoteError::Identity(
            "cannot connect this Mac to itself".into(),
        ));
    }
    if let Some(expected) = expected
        && expected != hello.host.id
    {
        return Err(RemoteError::IdentityMismatch {
            alias: target.host.clone(),
            expected,
            actual: hello.host.id,
        });
    }
    statglass_proto::negotiate(
        &Offer::local(statglass_proto::local_features()),
        &Offer::from(hello),
    )
    .map_err(|error| RemoteError::IncompatiblePeer {
        version: hello.app_version.clone(),
        reason: error.to_string(),
    })
}

// The same framing and 1 MiB transport envelope as the desktop session codec.
const MAX_WIRE_BYTES: usize = 1024 * 1024;

async fn read_hello(
    reader: &mut (impl AsyncRead + Unpin),
) -> std::result::Result<Box<Hello>, HandshakeFailure> {
    fn read_failure(error: std::io::Error) -> HandshakeFailure {
        match error.kind() {
            std::io::ErrorKind::UnexpectedEof => HandshakeFailure::Closed,
            kind => HandshakeFailure::Io(kind),
        }
    }
    let len = reader.read_u32().await.map_err(read_failure)? as usize;
    if len == 0 || len > MAX_WIRE_BYTES {
        return Err(HandshakeFailure::Invalid);
    }
    let mut body = vec![0; len];
    reader.read_exact(&mut body).await.map_err(read_failure)?;
    match statglass_proto::decode_message(&body) {
        Ok(Message::Hello(hello)) => Ok(hello),
        Ok(_) => Err(HandshakeFailure::NotHello),
        Err(_) => Err(HandshakeFailure::Invalid),
    }
}

async fn write_ack(writer: &mut (impl AsyncWrite + Unpin), negotiated: &Negotiated) -> Result<()> {
    let frame = statglass_proto::encode_frame(&Message::HelloAck(negotiated.ack()))?;
    if frame.len() > MAX_WIRE_BYTES + 4 {
        return Err(RemoteError::Protocol("outbound frame too large".into()));
    }
    writer.write_all(&frame).await?;
    writer.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests;
