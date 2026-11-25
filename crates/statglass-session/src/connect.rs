//! The shared handshake and the race across an endpoint's targets, on top of any
//! [`Dialer`].
use crate::{
    ConnectionFailureKind, DialFailure, DialedStream, Dialer, Endpoint, HandshakeFailure,
    IncompatibleSide, RemoteError, Result, RouteError, SshSession, Target, marker_error,
};
use statglass_proto::{HandshakeError, Hello, Message, Negotiated, Offer};
use statglass_schema::HostId;
use std::{
    future::{Future, pending, poll_fn},
    task::Poll,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
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
    connect_routes(dialer, endpoint, local, expected)
        .await
        .map_err(preferred_error)
}

/// Runs the race while keeping all route failures available for connection status.
pub(crate) async fn connect_routes(
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
    'race: while !attempts.is_empty() {
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
        let mut completed = completed.into_iter().peekable();
        while let Some((index, target, result)) = completed.next() {
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
                    if let Some((best_index, best)) = &preferred
                        && best.hello.host.id != session.hello.host.id
                    {
                        let (first, second) = if index < *best_index {
                            (target, &best.target)
                        } else {
                            (&best.target, target)
                        };
                        return Err(conflicting_identity(first, second));
                    }
                    if preferred.as_ref().is_none_or(|(best, _)| index < *best) {
                        preferred = Some((index, session));
                    }
                    grace.get_or_insert_with(|| Instant::now() + ROUTE_GRACE);
                }
            }
            if let Some((best, _)) = &preferred
                && attempts.first().is_none_or(|(index, ..)| index > best)
                && completed.peek().is_none_or(|(index, ..)| index > best)
            {
                break 'race;
            }
        }
    }
    preferred.map(|(_, session)| session).ok_or_else(|| {
        failures.sort_unstable_by_key(|(index, _)| *index);
        RemoteError::Routes(failures.into_iter().map(|(_, failure)| failure).collect())
    })
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

fn preferred_error(error: RemoteError) -> RemoteError {
    let RemoteError::Routes(_) = &error else {
        return error;
    };
    let kind = ConnectionFailureKind::from_error(&error);
    if kind == ConnectionFailureKind::AgentNotRunning {
        return RemoteError::AgentNotRunning(error.to_string());
    }
    if matches!(
        kind,
        ConnectionFailureKind::MonitoringOff | ConnectionFailureKind::AppNotRunning
    ) && let RemoteError::Routes(mut routes) = error
    {
        if let Some(index) = routes
            .iter()
            .position(|failure| ConnectionFailureKind::from_error(&failure.error) == kind)
        {
            return routes.swap_remove(index).error;
        }
        return RemoteError::Routes(routes);
    }
    error
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
    let mut features = statglass_proto::local_features();
    // Clients can read addresses as soon as a host implements and advertises its resolver.
    features.insert(statglass_proto::ADDRESSES_QUERY_FEATURE.into());
    statglass_proto::negotiate(&Offer::local(features), &Offer::from(hello)).map_err(|error| {
        let side = match error {
            HandshakeError::Incompatible {
                peer_max,
                local_min,
                ..
            } if peer_max < local_min => Some(IncompatibleSide::Host),
            HandshakeError::Incompatible {
                peer_min,
                local_max,
                ..
            } if peer_min > local_max => Some(IncompatibleSide::App),
            _ => None,
        };
        RemoteError::IncompatiblePeer {
            version: hello.app_version.clone(),
            reason: error.to_string(),
            side,
        }
    })
}

/// Reads the peer's greeting through the session codec, so framing and the 1 MiB
/// envelope have one definition.
async fn read_hello(
    reader: &mut (impl AsyncRead + Unpin),
) -> std::result::Result<Box<Hello>, HandshakeFailure> {
    match crate::codec::read(reader).await {
        Ok(Message::Hello(hello)) => Ok(hello),
        Ok(_) => Err(HandshakeFailure::NotHello),
        Err(RemoteError::Io(error)) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
            Err(HandshakeFailure::Closed)
        }
        Err(RemoteError::Io(error)) => Err(HandshakeFailure::Io(error.kind())),
        Err(_) => Err(HandshakeFailure::Invalid),
    }
}

async fn write_ack(writer: &mut (impl AsyncWrite + Unpin), negotiated: &Negotiated) -> Result<()> {
    crate::codec::write(writer, &Message::HelloAck(negotiated.ack())).await
}

#[cfg(test)]
mod tests;
