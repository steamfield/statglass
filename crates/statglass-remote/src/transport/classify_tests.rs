//! SSH stderr classification through the dialer seam.
use super::*;
use crate::UnreachableKind;

fn classify(stderr: &str, outcome: HandshakeFailure) -> RemoteError {
    OpenSshDialer::default().classify(&DialFailure {
        target: &Target {
            route: Route::Lan,
            host: "studio.local".into(),
        },
        stderr,
        outcome,
    })
}

fn kind_of(detail: &str) -> Option<UnreachableKind> {
    match classify(detail, HandshakeFailure::Closed) {
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
        classify(
            "ssh: connect to host studio.local port 22: Operation timed out",
            HandshakeFailure::Closed
        ),
        RemoteError::Timeout(_)
    ));
    assert!(matches!(
        classify(
            "user@studio.local: Permission denied (publickey).",
            HandshakeFailure::Closed
        ),
        RemoteError::Authentication(_)
    ));
    assert!(matches!(
        classify("Host key verification failed.", HandshakeFailure::Closed),
        RemoteError::HostKey(_)
    ));
}

#[test]
fn unrecognized_stderr_stays_a_transport_error() {
    assert!(matches!(
        classify(
            "kex_exchange_identification: read: Connection reset by peer",
            HandshakeFailure::Closed
        ),
        RemoteError::Transport(_)
    ));
}

#[test]
fn stalled_hello_uses_timeout_even_with_an_ssh_banner() {
    let timed_out = HandshakeFailure::TimedOut;
    assert!(matches!(
        classify("Warning: Permanently added", timed_out),
        RemoteError::Timeout(text) if text == "studio.local: Warning: Permanently added"
    ));
    assert!(matches!(
        classify("", timed_out),
        RemoteError::Timeout(text) if text == "studio.local: The host did not answer in time."
    ));
    assert!(matches!(
        classify("Host key verification failed.", timed_out),
        RemoteError::HostKey(text) if text == "studio.local: Host key verification failed."
    ));
}

#[test]
fn empty_stderr_uses_the_handshake_sentence() {
    for (outcome, expected) in [
        (
            HandshakeFailure::Closed,
            "studio.local: The connection closed before StatGlass could start on the host.",
        ),
        (
            HandshakeFailure::Invalid,
            "studio.local: The host sent an invalid StatGlass greeting.",
        ),
        (
            HandshakeFailure::NotHello,
            "studio.local: The host did not send a StatGlass greeting.",
        ),
    ] {
        assert!(
            matches!(classify("", outcome), RemoteError::Transport(text) if text == expected),
            "{outcome:?}"
        );
    }
}
