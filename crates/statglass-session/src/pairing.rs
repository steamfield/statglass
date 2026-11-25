//! The phone's side of pairing (RFC `plan/rfc-ios-app.md` 2.4): dial the host from the
//! QR with the one-time pairing key, send `PairStart`, wait for the host's decision, and
//! turn the approved bundle into the restricted [`Endpoint`] the phone keeps.
pub use crate::error::PairingRefusal;
use crate::{
    DialedStream, Dialer, Endpoint, ForcedToken, PinnedHostKey, RemoteCommand, RemoteError, Route,
    Target, codec,
};
pub use statglass_proto::pairing::PairError;
use statglass_proto::pairing::{
    BundleHost, BundleRoute, MAX_PAIR_FRAME_BYTES, PAIR_RECEIPT_GRACE, PairReply, PairStart,
    PairingPayload, decode_pair_body, encode_pair_frame,
};
use statglass_schema::HostId;
use std::future::{Future, poll_fn};
use std::task::Poll;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite};
use tokio::time::{Instant, sleep, timeout_at};

/// Pairs with the host in `payload`. `dialer` must authenticate with the payload's
/// pairing key (the caller builds it with that signer); the session runs
/// `RemoteCommand::Restricted { forced: Pair }`. Returns the restricted endpoint and the
/// final reply on approval, a typed error on denial or expiry.
pub async fn pair(
    dialer: &dyn Dialer,
    payload: &PairingPayload,
    device_key: &[u8],
    device_name: &str,
    model: &str,
    local: HostId,
) -> Result<(Endpoint, PairReply), RemoteError> {
    let remaining = payload
        .expires_ms
        .saturating_sub(statglass_engine::wall_ms());
    if remaining <= 0 {
        return Err(PairingRefusal::Expired.into());
    }
    if payload.host.host_id == local {
        return Err(RemoteError::Identity(
            "cannot pair this device to itself".into(),
        ));
    }
    let endpoint = endpoint_from_host(&payload.host, restricted(ForcedToken::Pair))?;
    let request = PairStart {
        nonce: payload.nonce.clone(),
        device_key: device_key.into(),
        device_name: device_name.into(),
        model: model.into(),
    };
    let deadline = Instant::now() + Duration::from_millis(remaining as u64);
    let mut stream = dial_pairing(dialer, &endpoint, deadline).await?;
    timeout_at(deadline, write_pair_frame(&mut stream.writer, &request))
        .await
        .map_err(|_| PairingRefusal::Expired)??;
    // The host owns the approval deadline. A decision made on time can still be
    // in flight on the control socket when that deadline passes.
    let reply = timeout_at(
        deadline + PAIR_RECEIPT_GRACE,
        read_decision(&mut stream.reader),
    )
    .await
    .map_err(|_| PairingRefusal::Expired)??;
    let PairReply::Approved { hosts, .. } = &reply else {
        return Err(RemoteError::Protocol("expected a pairing approval".into()));
    };
    let host = hosts
        .iter()
        .find(|host| host.host_id == payload.host.host_id)
        .ok_or_else(|| {
            RemoteError::Identity("approval did not include the host from the pairing code".into())
        })?;
    let endpoint = endpoint_from_host(host, restricted(ForcedToken::Serve))?;
    Ok((endpoint, reply))
}

async fn read_decision(reader: &mut (impl AsyncRead + Unpin)) -> crate::Result<PairReply> {
    loop {
        match read_pair_frame(reader).await? {
            PairReply::Waiting => continue,
            PairReply::Denied => return Err(PairingRefusal::Denied.into()),
            PairReply::Expired => return Err(PairingRefusal::Expired.into()),
            PairReply::Error { error } => return Err(PairingRefusal::Rejected(error).into()),
            PairReply::Pending { .. } => {
                return Err(RemoteError::Protocol(
                    "unexpected pairing approval prompt from host".into(),
                ));
            }
            approved @ PairReply::Approved { .. } => return Ok(approved),
        }
    }
}

/// The endpoint the phone dials `host` at with `command`: its targets in order, port,
/// user and pinned host keys.
pub fn endpoint_from_host(
    host: &BundleHost,
    command: RemoteCommand,
) -> Result<Endpoint, RemoteError> {
    if host.host_keys.is_empty() {
        return Err(RemoteError::HostKey(
            "pairing host offered no host keys".into(),
        ));
    }
    let endpoint = Endpoint {
        targets: host
            .targets
            .iter()
            .map(|target| Target {
                route: match target.route {
                    BundleRoute::Lan => Route::Lan,
                    BundleRoute::Tailscale => Route::Tailscale,
                },
                host: target.host.clone(),
            })
            .collect(),
        port: host.port,
        user: Some(host.user.clone()),
        host_keys: host
            .host_keys
            .iter()
            .map(|key| PinnedHostKey {
                algorithm: key.algorithm.clone(),
                sha256: key.sha256.clone(),
            })
            .collect(),
        command,
    };
    endpoint.validate()?;
    Ok(endpoint)
}

fn restricted(forced: ForcedToken) -> RemoteCommand {
    RemoteCommand::Restricted { forced }
}

/// Race the SSH routes, with the normal preference grace. Send the single-use
/// PairStart on only the winning stream.
async fn dial_pairing(
    dialer: &dyn Dialer,
    endpoint: &Endpoint,
    deadline: Instant,
) -> crate::Result<DialedStream> {
    let mut attempts: Vec<_> = endpoint
        .targets
        .iter()
        .map(|target| Some(Box::pin(dial_pairing_target(dialer, endpoint, target))))
        .collect();
    let mut chosen: Option<(usize, DialedStream)> = None;
    let mut failures = Vec::new();
    let mut grace = None;
    let mut deadline_timer = std::pin::pin!(tokio::time::sleep_until(deadline));
    poll_fn(|cx| {
        let preferred = chosen.as_ref().map_or(attempts.len(), |(index, _)| *index);
        for (index, slot) in attempts.iter_mut().take(preferred).enumerate() {
            let Some(attempt) = slot else { continue };
            let Poll::Ready(result) = attempt.as_mut().poll(cx) else {
                continue;
            };
            *slot = None;
            match result {
                Ok(stream) => {
                    chosen = Some((index, stream));
                    break;
                }
                Err(error) => failures.push(error),
            }
        }
        if let Some((index, stream)) = chosen.take() {
            let waiting = attempts.iter().take(index).any(Option::is_some);
            let elapsed = waiting
                && grace
                    .get_or_insert_with(|| {
                        let remaining = deadline.saturating_duration_since(Instant::now());
                        Box::pin(sleep(crate::ROUTE_GRACE.min(remaining / 2)))
                    })
                    .as_mut()
                    .poll(cx)
                    .is_ready();
            if !waiting || elapsed {
                return Poll::Ready(Ok(stream));
            }
            chosen = Some((index, stream));
        } else if attempts.iter().all(Option::is_none) {
            return Poll::Ready(Err(failures
                .drain(..)
                .min_by_key(RemoteError::retryable)
                .unwrap_or_else(|| {
                    RemoteError::Protocol("pairing host offered no dial targets".into())
                })));
        }
        if deadline_timer.as_mut().poll(cx).is_ready() {
            return Poll::Ready(chosen.take().map(|(_, stream)| stream).ok_or_else(|| {
                failures.pop().unwrap_or_else(|| {
                    RemoteError::Timeout("opening the pairing connection timed out".into())
                })
            }));
        }
        Poll::Pending
    })
    .await
}

async fn dial_pairing_target(
    dialer: &dyn Dialer,
    endpoint: &Endpoint,
    target: &Target,
) -> crate::Result<DialedStream> {
    tokio::time::timeout(crate::HANDSHAKE_TIMEOUT, dialer.dial(endpoint, target))
        .await
        .map_err(|_| {
            RemoteError::Timeout(format!(
                "{}: opening the pairing connection timed out",
                target.host
            ))
        })?
}

/// Reads a length-prefixed pairing frame.
///
/// # Errors
///
/// Returns `Protocol` for zero or over [`MAX_PAIR_FRAME_BYTES`], a codec `Decode` error
/// for malformed CBOR or trailing bytes, and an I/O error for a failed read.
pub async fn read_pair_frame<T: serde::de::DeserializeOwned>(
    reader: &mut (impl AsyncRead + Unpin),
) -> crate::Result<T> {
    let len = reader.read_u32().await? as usize;
    if len == 0 || len > MAX_PAIR_FRAME_BYTES {
        return Err(RemoteError::Protocol(format!(
            "invalid pairing frame length {len}"
        )));
    }
    let mut body = vec![0; len];
    reader.read_exact(&mut body).await?;
    Ok(decode_pair_body(&body)?)
}

/// Encodes and writes a length-prefixed pairing frame.
///
/// # Errors
///
/// Returns a codec error if serialization fails or the body exceeds [`MAX_PAIR_FRAME_BYTES`],
/// an I/O error for a failed write, or `Transport` if the peer stops reading.
pub async fn write_pair_frame(
    writer: &mut (impl AsyncWrite + Unpin),
    value: &impl serde::Serialize,
) -> crate::Result<()> {
    codec::write_frame(writer, &encode_pair_frame(value)?).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BoxFuture, Close, DialFailure, StderrTail};
    use statglass_proto::pairing::{BundleHostKey, BundleTarget, PAYLOAD_VERSION};
    use std::sync::Mutex;
    use tokio::io::{DuplexStream, duplex};

    const LOCAL: HostId = HostId(uuid::Uuid::from_u128(1));
    const HOST: HostId = HostId(uuid::Uuid::from_u128(2));

    struct NoopClose;
    impl Close for NoopClose {
        fn close(self: Box<Self>) -> BoxFuture<'static, ()> {
            Box::pin(async {})
        }
    }

    struct FakeDialer {
        stream: Mutex<Option<DuplexStream>>,
        attempts: Mutex<Vec<(Endpoint, Target)>>,
        reject_lan: bool,
        stalled_route: Option<Route>,
    }

    impl Dialer for FakeDialer {
        fn dial<'a>(
            &'a self,
            endpoint: &'a Endpoint,
            target: &'a Target,
        ) -> BoxFuture<'a, crate::Result<DialedStream>> {
            Box::pin(async move {
                self.attempts
                    .lock()
                    .unwrap()
                    .push((endpoint.clone(), target.clone()));
                if self.stalled_route == Some(target.route) {
                    return std::future::pending().await;
                }
                if self.reject_lan && target.route == Route::Lan {
                    return Err(RemoteError::Unreachable {
                        kind: crate::UnreachableKind::NoRoute,
                        detail: format!("{} unavailable", target.host),
                    });
                }
                let stream = self
                    .stream
                    .lock()
                    .unwrap()
                    .take()
                    .expect("only one stream can send a PairStart");
                let (reader, writer) = tokio::io::split(stream);
                Ok(DialedStream {
                    reader: Box::pin(reader),
                    writer: Box::pin(writer),
                    stderr: StderrTail::default(),
                    close: Box::new(NoopClose),
                })
            })
        }

        fn classify(&self, _failure: &DialFailure<'_>) -> RemoteError {
            unreachable!()
        }
    }

    fn fixture(reject_lan: bool) -> (FakeDialer, PairingPayload, DuplexStream) {
        let (client, peer) = duplex(2048);
        let dialer = FakeDialer {
            stream: Mutex::new(Some(client)),
            attempts: Mutex::default(),
            reject_lan,
            stalled_route: None,
        };
        let payload = PairingPayload {
            version: PAYLOAD_VERSION,
            pairing_key: [0; 32],
            nonce: "55bb3aa9cf3c45d7df0b70dd41999f43".into(),
            code: "AAA222".into(),
            expires_ms: statglass_engine::wall_ms() + 60_000,
            can_hand_over: false,
            host: BundleHost {
                host_id: HOST,
                name: "office".into(),
                os: "linux".into(),
                user: "statglass".into(),
                port: Some(2222),
                targets: vec![
                    BundleTarget {
                        route: BundleRoute::Lan,
                        host: "office.local".into(),
                    },
                    BundleTarget {
                        route: BundleRoute::Tailscale,
                        host: "100.64.10.10".into(),
                    },
                ],
                host_keys: vec![BundleHostKey {
                    algorithm: "ssh-ed25519".into(),
                    sha256: "SHA256:fixture".into(),
                }],
            },
        };
        (dialer, payload, peer)
    }

    #[tokio::test(start_paused = true)]
    async fn pairing_client_sends_one_start_and_returns_a_restricted_pinned_endpoint_after_waiting()
    {
        let (dialer, payload, mut peer) = fixture(true);
        let final_reply = PairReply::Approved {
            device: "7F3A2C".into(),
            hosts: vec![payload.host.clone()],
        };
        let approve = async {
            let start = read_pair_frame::<PairStart>(&mut peer).await.unwrap();
            assert_eq!(
                start,
                PairStart {
                    nonce: payload.nonce.clone(),
                    device_key: vec![4; 65],
                    device_name: "iPhone".into(),
                    model: "iPhone 17".into()
                }
            );
            write_pair_frame(&mut peer, &PairReply::Waiting)
                .await
                .unwrap();
            write_pair_frame(&mut peer, &PairReply::Waiting)
                .await
                .unwrap();
            write_pair_frame(&mut peer, &final_reply).await.unwrap();
        };
        let (result, ()) = tokio::join!(
            pair(&dialer, &payload, &[4; 65], "iPhone", "iPhone 17", LOCAL),
            approve
        );
        let (endpoint, reply) = result.unwrap();
        assert_eq!(reply, final_reply);
        assert_eq!(endpoint.command, restricted(ForcedToken::Serve));
        let attempts = dialer.attempts.lock().unwrap();
        assert_eq!(
            attempts
                .iter()
                .map(|(_, target)| target.route)
                .collect::<Vec<_>>(),
            [Route::Lan, Route::Tailscale]
        );
        for (offered, _) in attempts.iter() {
            assert_eq!(offered.command, restricted(ForcedToken::Pair));
            assert_eq!(offered.targets, endpoint.targets);
            assert_eq!(offered.port, Some(2222));
            assert_eq!(offered.user.as_deref(), Some("statglass"));
            assert_eq!(
                offered.host_keys,
                [PinnedHostKey {
                    algorithm: "ssh-ed25519".into(),
                    sha256: "SHA256:fixture".into()
                }]
            );
            assert_eq!(offered.host_keys, endpoint.host_keys);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn pairing_client_returns_typed_denied_expired_and_used_replies() {
        for reply in [
            PairReply::Denied,
            PairReply::Expired,
            PairReply::Error {
                error: PairError::Used,
            },
        ] {
            let (dialer, payload, mut peer) = fixture(false);
            let decide = async {
                read_pair_frame::<PairStart>(&mut peer).await.unwrap();
                write_pair_frame(&mut peer, &PairReply::Waiting)
                    .await
                    .unwrap();
                write_pair_frame(&mut peer, &reply).await.unwrap();
            };
            let (result, ()) = tokio::join!(
                pair(&dialer, &payload, &[], "iPhone", "iPhone 17", LOCAL),
                decide
            );
            assert!(matches!(
                (reply, result.unwrap_err()),
                (
                    PairReply::Denied,
                    RemoteError::Pairing(PairingRefusal::Denied)
                ) | (
                    PairReply::Expired,
                    RemoteError::Pairing(PairingRefusal::Expired)
                ) | (
                    PairReply::Error {
                        error: PairError::Used
                    },
                    RemoteError::Pairing(PairingRefusal::Rejected(PairError::Used))
                )
            ));
            assert_eq!(dialer.attempts.lock().unwrap().len(), 1);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn pairing_client_expires_locally_and_disconnects_if_the_host_stops_answering() {
        let (dialer, payload, mut peer) = fixture(false);
        let remote = async {
            read_pair_frame::<PairStart>(&mut peer).await.unwrap();
            write_pair_frame(&mut peer, &PairReply::Waiting)
                .await
                .unwrap();
            tokio::time::advance(Duration::from_secs(72)).await;
            assert_eq!(
                peer.read_u8().await.unwrap_err().kind(),
                std::io::ErrorKind::UnexpectedEof
            );
        };
        let (result, ()) = tokio::join!(
            pair(&dialer, &payload, &[], "iPhone", "iPhone 17", LOCAL),
            remote
        );
        assert!(matches!(
            result,
            Err(RemoteError::Pairing(PairingRefusal::Expired))
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn pairing_client_accepts_a_host_decision_relayed_just_after_the_offer_expires() {
        let (dialer, payload, mut peer) = fixture(false);
        let approved = PairReply::Approved {
            device: "7F3A2C".into(),
            hosts: vec![payload.host.clone()],
        };
        let remote = async {
            read_pair_frame::<PairStart>(&mut peer).await.unwrap();
            write_pair_frame(&mut peer, &PairReply::Waiting)
                .await
                .unwrap();
            tokio::time::advance(Duration::from_secs(61)).await;
            tokio::task::yield_now().await;
            let _ = write_pair_frame(&mut peer, &approved).await;
        };
        let (result, ()) = tokio::join!(
            pair(&dialer, &payload, &[], "iPhone", "iPhone 17", LOCAL),
            remote
        );
        assert_eq!(result.unwrap().1, approved);
    }

    #[tokio::test(start_paused = true)]
    async fn pairing_client_tries_a_live_tailscale_route_before_a_stalled_lan_dial_times_out() {
        let (mut dialer, mut payload, mut peer) = fixture(false);
        dialer.stalled_route = Some(Route::Lan);
        payload.expires_ms = statglass_engine::wall_ms() + 250;
        let remote = async {
            if let Ok(Ok(_)) = tokio::time::timeout(
                Duration::from_secs(3),
                read_pair_frame::<PairStart>(&mut peer),
            )
            .await
            {
                write_pair_frame(&mut peer, &PairReply::Denied)
                    .await
                    .unwrap();
            }
        };
        let (result, ()) = tokio::join!(
            pair(&dialer, &payload, &[], "iPhone", "iPhone 17", LOCAL),
            remote
        );
        assert!(matches!(
            result,
            Err(RemoteError::Pairing(PairingRefusal::Denied))
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn pairing_deadline_keeps_the_last_dial_failure_while_another_route_stalls() {
        let (mut dialer, mut payload, _peer) = fixture(true);
        dialer.stalled_route = Some(Route::Tailscale);
        payload.host.targets.insert(
            1,
            BundleTarget {
                route: BundleRoute::Lan,
                host: "other.local".into(),
            },
        );
        payload.expires_ms = statglass_engine::wall_ms() + 250;
        let result = pair(&dialer, &payload, &[], "iPhone", "iPhone 17", LOCAL).await;
        assert!(matches!(
            result,
            Err(RemoteError::Unreachable {
                kind: crate::UnreachableKind::NoRoute,
                detail
            }) if detail == "other.local unavailable"
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn pairing_deadline_during_a_stalled_dial_reports_a_connection_timeout() {
        let (mut dialer, mut payload, _peer) = fixture(false);
        dialer.stalled_route = Some(Route::Lan);
        payload.host.targets.truncate(1);
        payload.expires_ms = statglass_engine::wall_ms() + 250;
        let result = pair(&dialer, &payload, &[], "iPhone", "iPhone 17", LOCAL).await;
        assert!(matches!(result, Err(RemoteError::Timeout(_))));
    }

    #[tokio::test(start_paused = true)]
    async fn pairing_client_refuses_empty_pins_targets_or_expired_codes_before_dialing() {
        let (dialer, payload, _peer) = fixture(false);
        let mut no_keys = payload.clone();
        no_keys.host.host_keys.clear();
        assert!(matches!(
            pair(&dialer, &no_keys, &[], "iPhone", "iPhone 17", LOCAL).await,
            Err(RemoteError::HostKey(_))
        ));
        let mut no_targets = payload.clone();
        no_targets.host.targets.clear();
        assert!(matches!(
            pair(&dialer, &no_targets, &[], "iPhone", "iPhone 17", LOCAL).await,
            Err(RemoteError::Protocol(_))
        ));
        let expired = PairingPayload {
            expires_ms: 0,
            ..payload
        };
        assert!(matches!(
            pair(&dialer, &expired, &[], "iPhone", "iPhone 17", LOCAL).await,
            Err(RemoteError::Pairing(PairingRefusal::Expired))
        ));
        assert!(dialer.attempts.lock().unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn pairing_client_rejects_approval_for_a_different_host() {
        let (dialer, payload, mut peer) = fixture(false);
        let approve = async {
            read_pair_frame::<PairStart>(&mut peer).await.unwrap();
            let mut other = payload.host.clone();
            other.host_id = HostId(uuid::Uuid::from_u128(3));
            write_pair_frame(
                &mut peer,
                &PairReply::Approved {
                    device: "7F3A2C".into(),
                    hosts: vec![other],
                },
            )
            .await
            .unwrap();
        };
        let (result, ()) = tokio::join!(
            pair(&dialer, &payload, &[], "iPhone", "iPhone 17", LOCAL),
            approve
        );
        assert!(matches!(result, Err(RemoteError::Identity(_))));
    }
}
