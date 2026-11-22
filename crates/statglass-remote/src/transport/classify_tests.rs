//! SSH stderr classification and dual-route combination.
use super::*;
use crate::UnreachableKind;

/// What `dial` sees when ssh exits before the greeting: the stream closes.
fn closed() -> std::result::Result<Result<Message>, tokio::time::error::Elapsed> {
    Ok(Err(RemoteError::Io(
        std::io::ErrorKind::UnexpectedEof.into(),
    )))
}

fn kind_of(detail: &str) -> Option<UnreachableKind> {
    match stderr_error("studio.local", detail.into(), &closed()) {
        RemoteError::Unreachable { kind, detail } => {
            assert!(detail.starts_with("studio.local: "), "{detail}");
            Some(kind)
        }
        _ => None,
    }
}

#[test]
fn dns_failures_read_as_name_not_resolved() {
    for line in [
        "ssh: Could not resolve hostname studio.local: nodename nor servname provided, or not known",
        "ssh: Could not resolve hostname studio: Name or service not known",
        "ssh: Could not resolve hostname studio: Temporary failure in name resolution",
    ] {
        assert_eq!(
            kind_of(line),
            Some(UnreachableKind::NameNotResolved),
            "{line}"
        );
    }
}

#[test]
fn refused_connections_read_as_refused() {
    assert_eq!(
        kind_of("ssh: connect to host 10.0.0.5 port 22: Connection refused"),
        Some(UnreachableKind::Refused)
    );
}

#[test]
fn routing_failures_read_as_no_route() {
    for line in [
        "ssh: connect to host 10.0.0.5 port 22: No route to host",
        "ssh: connect to host 10.0.0.5 port 22: Network is unreachable",
        "ssh: connect to host 10.0.0.5 port 22: Host is down",
    ] {
        assert_eq!(kind_of(line), Some(UnreachableKind::NoRoute), "{line}");
    }
}

#[test]
fn classification_ignores_banner_lines_before_the_error() {
    let detail = "Warning: Permanently added 'studio.local' (ED25519) to the list of known hosts.\nssh: connect to host studio.local port 22: Connection refused";
    assert_eq!(kind_of(detail), Some(UnreachableKind::Refused));
}

#[test]
fn timeouts_auth_and_host_keys_keep_their_variants() {
    assert!(matches!(
        stderr_error(
            "studio.local",
            "ssh: connect to host studio.local port 22: Operation timed out".into(),
            &closed()
        ),
        RemoteError::Timeout(_)
    ));
    assert!(matches!(
        stderr_error(
            "studio.local",
            "user@studio.local: Permission denied (publickey).".into(),
            &closed()
        ),
        RemoteError::Authentication(_)
    ));
    assert!(matches!(
        stderr_error(
            "studio.local",
            "Host key verification failed.".into(),
            &closed()
        ),
        RemoteError::HostKey(_)
    ));
}

#[test]
fn unrecognized_stderr_stays_a_transport_error() {
    assert!(matches!(
        stderr_error(
            "studio.local",
            "kex_exchange_identification: read: Connection reset by peer".into(),
            &closed()
        ),
        RemoteError::Transport(_)
    ));
}

#[test]
fn two_retryable_route_failures_combine_into_both_routes() {
    let lan = RemoteError::Unreachable {
        kind: UnreachableKind::NameNotResolved,
        detail: "studio.local: dns".into(),
    };
    let tailscale = RemoteError::Timeout("studio: timed out".into());
    match combine(lan, tailscale) {
        RemoteError::BothRoutes { lan, tailscale } => {
            assert!(matches!(
                *lan,
                RemoteError::Unreachable {
                    kind: UnreachableKind::NameNotResolved,
                    ..
                }
            ));
            assert!(matches!(*tailscale, RemoteError::Timeout(_)));
        }
        other => panic!("expected BothRoutes, got {other:?}"),
    }
}

#[test]
fn a_non_retryable_route_still_wins_alone() {
    let combined = combine(
        RemoteError::Timeout("studio.local: timed out".into()),
        RemoteError::HostKey("studio: changed".into()),
    );
    assert!(matches!(combined, RemoteError::HostKey(_)));
}

#[test]
fn both_routes_is_retryable_and_keeps_the_combined_text() {
    let both = RemoteError::BothRoutes {
        lan: Box::new(RemoteError::Transport("a".into())),
        tailscale: Box::new(RemoteError::Transport("b".into())),
    };
    assert!(both.retryable());
    assert_eq!(both.to_string(), "LAN: a; Tailscale: b");
    assert!(
        RemoteError::Unreachable {
            kind: UnreachableKind::Refused,
            detail: "x".into()
        }
        .retryable()
    );
}
