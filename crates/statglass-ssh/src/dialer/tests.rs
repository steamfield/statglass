use super::*;
use crate::{
    SignerError, SoftwareSigner,
    test_server::{End, Event, Script, Server},
};
use statglass_session::{RemoteCommand, Route, STDERR_TAIL_BYTES};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpSocket},
};

fn dial<'a>(
    dialer: &'a RusshDialer,
    endpoint: &'a Endpoint,
) -> BoxFuture<'a, Result<DialedStream>> {
    dialer.dial(endpoint, &endpoint.targets[0])
}

async fn dial_error(dialer: &RusshDialer, endpoint: &Endpoint) -> RemoteError {
    match dial(dialer, endpoint).await {
        Ok(_) => panic!("unexpectedly opened an SSH stream"),
        Err(err) => err,
    }
}

fn endpoint(host: &str, port: u16) -> Endpoint {
    Endpoint {
        targets: vec![Target {
            route: Route::Lan,
            host: host.into(),
        }],
        port: Some(port),
        user: Some("statglass".into()),
        host_keys: vec![PinnedHostKey {
            algorithm: "ssh-ed25519".into(),
            sha256: "SHA256:unused".into(),
        }],
        command: RemoteCommand::default(),
    }
}

#[tokio::test]
async fn exec_carries_stdio_without_extra_requests_and_closes_orderly() {
    let key = Arc::new(SoftwareSigner::generate());
    let script = Script {
        stdout: b"hello\0".to_vec(),
        ..Default::default()
    };
    let server = Server::start(&key, script).await;
    let mut endpoint = server.endpoint.clone();
    endpoint.targets[0].host = "localhost".into();
    // Pairing can supply several pins. A wrong entry must not hide a later match.
    endpoint.host_keys.insert(
        0,
        PinnedHostKey {
            algorithm: "ssh-ed25519".into(),
            sha256: "SHA256:other".into(),
        },
    );
    let dialer = RusshDialer::new(key);
    let mut stream = dial(&dialer, &endpoint).await.unwrap();
    let mut hello = [0; 6];
    timeout(Duration::from_secs(1), stream.reader.read_exact(&mut hello))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&hello, b"hello\0");
    stream.writer.write_all(b"ack\0").await.unwrap();
    let mut echo = [0; 4];
    timeout(Duration::from_secs(1), stream.reader.read_exact(&mut echo))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&echo, b"ack\0");
    stream.close.close().await;

    let events = server.finish().await;
    let requests: Vec<_> = events
        .iter()
        .filter(|event| **event != Event::TcpClosed)
        .collect();
    assert_eq!(
        requests,
        [
            &Event::AuthOffer("statglass".into()),
            &Event::Auth("statglass".into()),
            &Event::Open,
            &Event::Exec(endpoint.command.serve_command().unwrap().into_bytes()),
            &Event::Data(b"ack\0".to_vec()),
            &Event::Eof,
        ]
    );
    assert!(events.contains(&Event::TcpClosed));
}

#[tokio::test]
async fn reader_reaches_eof_on_remote_eof_or_close_and_captures_stderr() {
    let key = Arc::new(SoftwareSigner::generate());
    let dialer = RusshDialer::new(key.clone());
    for end in [End::Eof, End::Close] {
        let mut stderr = vec![b'e'; STDERR_TAIL_BYTES];
        stderr.extend_from_slice(b"discard this");
        let script = Script {
            stdout: b"one frame".to_vec(),
            stderr,
            end: Some(end),
            ..Default::default()
        };
        let server = Server::start(&key, script).await;
        let mut stream = dial(&dialer, &server.endpoint).await.unwrap();
        let mut stdout = Vec::new();
        timeout(
            Duration::from_secs(1),
            stream.reader.read_to_end(&mut stdout),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(stdout, b"one frame");
        stream.close.close().await;
        assert_eq!(stream.stderr.text(), "e".repeat(STDERR_TAIL_BYTES));
        assert!(server.finish().await.contains(&Event::TcpClosed));
    }
}

#[tokio::test]
async fn stdout_and_stderr_arriving_before_exec_confirmation_are_kept() {
    let key = Arc::new(SoftwareSigner::generate());
    let expected = vec![b'o'; 96 * 1024];
    let script = Script {
        stdout: expected.clone(),
        stderr: b"early stderr".to_vec(),
        output_before_exec_reply: true,
        end: Some(End::Eof),
        ..Default::default()
    };
    let server = Server::start(&key, script).await;
    let mut stream = timeout(
        Duration::from_secs(1),
        dial(&RusshDialer::new(key), &server.endpoint),
    )
    .await
    .expect("stdout filled the pipe before the client could observe exec confirmation")
    .unwrap();
    let mut stdout = Vec::new();
    timeout(
        Duration::from_secs(1),
        stream.reader.read_to_end(&mut stdout),
    )
    .await
    .unwrap()
    .unwrap();
    stream.close.close().await;
    assert!(server.finish().await.contains(&Event::TcpClosed));
    assert_eq!(stdout, expected);
    assert_eq!(stream.stderr.text(), "early stderr");
}

#[tokio::test]
async fn stderr_marker_and_stdout_after_exit_status_survive_until_eof() {
    use statglass_session::AGENT_NOT_RUNNING;

    let key = Arc::new(SoftwareSigner::generate());
    let script = Script {
        stdout: b"last stdout".to_vec(),
        stderr: format!("{AGENT_NOT_RUNNING}\n").into_bytes(),
        end: Some(End::Eof),
        exit_before_output: Some(3),
        ..Default::default()
    };
    let server = Server::start(&key, script).await;
    let mut stream = dial(&RusshDialer::new(key), &server.endpoint)
        .await
        .unwrap();
    let mut stdout = Vec::new();
    timeout(
        Duration::from_secs(1),
        stream.reader.read_to_end(&mut stdout),
    )
    .await
    .unwrap()
    .unwrap();
    stream.close.close().await;
    assert!(server.finish().await.contains(&Event::TcpClosed));
    assert_eq!(stdout, b"last stdout");
    assert_eq!(stream.stderr.text(), AGENT_NOT_RUNNING);
}

#[tokio::test]
async fn either_missing_pin_or_missing_user_fails_before_tcp_connect() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let paired = endpoint("127.0.0.1", listener.local_addr().unwrap().port());
    let dialer = RusshDialer::new(Arc::new(SoftwareSigner::generate()));
    for (test, expected) in [
        (
            Endpoint {
                host_keys: vec![],
                ..paired.clone()
            },
            "a paired SSH host key is required",
        ),
        (
            Endpoint {
                user: None,
                ..paired.clone()
            },
            "an SSH user is required",
        ),
    ] {
        let error = tokio::select! {
            biased;
            result = listener.accept() => panic!("invalid endpoint opened TCP: {result:?}"),
            error = dial_error(&dialer, &test) => error,
        };
        assert!(
            matches!(error, RemoteError::Protocol(detail) if detail == format!("127.0.0.1: {expected}"))
        );
    }
}

#[tokio::test]
async fn pin_checks_algorithm_and_fingerprint_before_authentication() {
    let key = Arc::new(SoftwareSigner::generate());
    let dialer = RusshDialer::new(key.clone());
    for matching_algorithm in [true, false] {
        let server = Server::start(&key, Script::default()).await;
        let mut endpoint = server.endpoint.clone();
        let fp = endpoint.host_keys[0].sha256.clone();
        if matching_algorithm {
            endpoint.host_keys[0].sha256 = "SHA256:other".into();
        } else {
            endpoint.host_keys[0].algorithm = "ecdsa-sha2-nistp256".into();
        }
        let error = dial_error(&dialer, &endpoint).await;
        assert!(
            matches!(error, RemoteError::HostKey(detail) if detail == format!("127.0.0.1: host key does not match the paired key ({fp})"))
        );
        assert_eq!(server.finish().await, [Event::TcpClosed]);
    }
}

#[tokio::test]
async fn rejected_client_key_is_an_authentication_error() {
    let allowed = SoftwareSigner::generate();
    let dialer = RusshDialer::new(Arc::new(SoftwareSigner::generate()));
    let server = Server::start(&allowed, Script::default()).await;
    let error = dial_error(&dialer, &server.endpoint).await;
    assert!(
        matches!(error, RemoteError::Authentication(detail) if detail == "127.0.0.1: the host rejected the SSH key for statglass")
    );
    assert_eq!(
        server.finish().await,
        [
            Event::AuthOffer("statglass".into()),
            Event::Auth("statglass".into()),
            Event::TcpClosed
        ]
    );
}

#[tokio::test]
async fn disconnect_during_authentication_allows_other_routes_to_continue() {
    let key = Arc::new(SoftwareSigner::generate());
    let server = Server::start(
        &key,
        Script {
            disconnect_during_auth: true,
            ..Default::default()
        },
    )
    .await;
    let error = dial_error(&RusshDialer::new(key), &server.endpoint).await;
    assert!(error.retryable(), "{error:?}");
    assert!(
        matches!(error, RemoteError::Transport(detail) if detail == "127.0.0.1: SSH connection closed during authentication")
    );
    assert_eq!(
        server.finish().await,
        [
            Event::AuthOffer("statglass".into()),
            Event::Auth("statglass".into()),
            Event::TcpClosed
        ]
    );
}

struct FailedSignature {
    key: Arc<SoftwareSigner>,
    malformed_der: bool,
}

impl Signer for FailedSignature {
    fn public_key(&self) -> &[u8] {
        self.key.public_key()
    }

    fn sign(&self, _: Vec<u8>) -> BoxFuture<'static, std::result::Result<Vec<u8>, SignerError>> {
        let malformed_der = self.malformed_der;
        Box::pin(async move {
            if malformed_der {
                Ok(vec![0x30, 0x01])
            } else {
                Err(SignerError::Unavailable("fixture key was deleted".into()))
            }
        })
    }
}

#[tokio::test]
async fn malformed_and_unavailable_signatures_keep_the_authentication_cause() {
    let key = Arc::new(SoftwareSigner::generate());
    for (malformed_der, prefix) in [
        (true, "127.0.0.1: invalid signature: P-256 DER:"),
        (
            false,
            "127.0.0.1: signing key unavailable: fixture key was deleted",
        ),
    ] {
        let server = Server::start(&key, Script::default()).await;
        let dialer = RusshDialer::new(Arc::new(FailedSignature {
            key: key.clone(),
            malformed_der,
        }));
        let error = dial_error(&dialer, &server.endpoint).await;
        assert!(matches!(error, RemoteError::Authentication(detail) if detail.starts_with(prefix)));
        assert_eq!(
            server.finish().await,
            [Event::AuthOffer("statglass".into()), Event::TcpClosed]
        );
    }
}

#[tokio::test]
async fn server_can_refuse_exec_after_authentication() {
    let key = Arc::new(SoftwareSigner::generate());
    let server = Server::start(
        &key,
        Script {
            refuse_exec: true,
            ..Default::default()
        },
    )
    .await;
    let command = server
        .endpoint
        .command
        .serve_command()
        .unwrap()
        .into_bytes();
    let error = dial_error(&RusshDialer::new(key), &server.endpoint).await;
    assert!(
        matches!(error, RemoteError::Transport(detail) if detail == "127.0.0.1: SSH exec refused")
    );
    assert_eq!(
        server.finish().await,
        [
            Event::AuthOffer("statglass".into()),
            Event::Auth("statglass".into()),
            Event::Open,
            Event::Exec(command),
            Event::TcpClosed
        ]
    );
}

#[tokio::test]
async fn refused_port_and_unresolvable_name_are_distinct() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (outbound, inbound) = tokio::join!(
        TcpStream::connect(listener.local_addr().unwrap()),
        listener.accept()
    );
    let outbound = outbound.unwrap();
    let _inbound = inbound.unwrap();
    // The outbound socket reserves its local port but is not listening for new
    // connections. A connect from a different socket receives a TCP refusal.
    let port = outbound.local_addr().unwrap().port();
    let contender = TcpSocket::new_v4().unwrap();
    assert!(
        contender.bind(([127, 0, 0, 1], port).into()).is_err(),
        "the refused port must stay reserved during the test"
    );
    let dialer = RusshDialer::new(Arc::new(SoftwareSigner::generate()));
    for (host, expected) in [
        ("127.0.0.1", UnreachableKind::Refused),
        ("statglass-test.invalid.", UnreachableKind::NameNotResolved),
    ] {
        let error = dial_error(&dialer, &endpoint(host, port)).await;
        assert!(
            matches!(&error, RemoteError::Unreachable { kind, detail } if *kind == expected && detail.starts_with(&format!("{host}: "))),
            "{host}: {error:?}"
        );
    }
}

#[test]
fn no_route_os_errors_keep_the_host_and_distinct_classification() {
    for kind in [
        io::ErrorKind::HostUnreachable,
        io::ErrorKind::NetworkUnreachable,
    ] {
        assert_no_route(&io::Error::from(kind));
    }
    #[cfg(target_vendor = "apple")]
    assert_no_route(&io::Error::from_raw_os_error(64));
    #[cfg(target_os = "linux")]
    assert_no_route(&io::Error::from_raw_os_error(112));
}

fn assert_no_route(error: &io::Error) {
    assert!(
        matches!(connect_error("studio", error), RemoteError::Unreachable { kind: UnreachableKind::NoRoute, detail } if detail == format!("studio: SSH connect: {error}"))
    );
}

#[tokio::test]
async fn silent_tcp_peer_times_out_and_socket_closes() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = endpoint("127.0.0.1", listener.local_addr().unwrap().port());
    let limit = Duration::from_millis(250);
    let config = RusshConfig {
        connect_timeout: limit,
        ..Default::default()
    };
    let dialer = RusshDialer::with_config(Arc::new(SoftwareSigner::generate()), config);
    let start = tokio::time::Instant::now();
    let mut result = Box::pin(dial_error(&dialer, &endpoint));
    let (mut tcp, _) = tokio::select! {
        peer = listener.accept() => peer.unwrap(),
        _ = &mut result => panic!("dial ended before the listener accepted the connection"),
    };
    tokio::time::pause();
    let tolerance = Duration::from_millis(5);
    let deadline = start + limit;
    assert!(
        tokio::time::timeout_at(deadline - tolerance, &mut result)
            .await
            .is_err()
    );
    let result = tokio::time::timeout_at(deadline + tolerance, &mut result)
        .await
        .unwrap();
    tokio::time::resume();
    assert!(
        matches!(result, RemoteError::Timeout(detail) if detail == "127.0.0.1: SSH connection timed out")
    );
    let mut greeting = Vec::new();
    timeout(Duration::from_secs(1), tcp.read_to_end(&mut greeting))
        .await
        .unwrap()
        .unwrap();
    assert!(greeting.starts_with(b"SSH-2.0-"));
}

#[tokio::test]
async fn dropping_dial_mid_auth_closes_tcp_before_auth_reply() {
    let key = Arc::new(SoftwareSigner::generate());
    let mut server = Server::start(
        &key,
        Script {
            delay_auth: true,
            ..Default::default()
        },
    )
    .await;
    let endpoint = server.endpoint.clone();
    let dialer = RusshDialer::new(key);
    let mut dial = dial(&dialer, &endpoint);
    let event = async {
        assert_eq!(server.next().await, Event::AuthOffer("statglass".into()));
        server.next().await
    };
    tokio::select! {
        event = event => assert_eq!(event, Event::Auth("statglass".into())),
        _ = &mut dial => panic!("dial finished without the held auth reply"),
    }
    drop(dial);
    assert_eq!(server.finish().await, [Event::TcpClosed]);
}

#[tokio::test]
async fn dropping_dial_during_key_exchange_closes_tcp_before_russh_returns_a_handle() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = endpoint("127.0.0.1", listener.local_addr().unwrap().port());
    let dialer = RusshDialer::new(Arc::new(SoftwareSigner::generate()));
    let mut dial = dial(&dialer, &endpoint);
    let begin_kex = async {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut peer = BufReader::new(tcp);
        let mut greeting = Vec::new();
        peer.read_until(b'\n', &mut greeting).await.unwrap();
        assert!(greeting.starts_with(b"SSH-2.0-"));
        peer.write_all(b"SSH-2.0-fixture\r\n").await.unwrap();
        assert!(!peer.fill_buf().await.unwrap().is_empty());
        peer
    };
    let mut peer = tokio::select! {
        result = timeout(Duration::from_secs(1), begin_kex) => result.unwrap(),
        _ = &mut dial => panic!("dial finished without the peer's key exchange"),
    };
    drop(dial);
    timeout(Duration::from_secs(1), peer.read_to_end(&mut Vec::new()))
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn dropping_the_stream_disconnects_even_if_the_writer_is_retained() {
    let key = Arc::new(SoftwareSigner::generate());
    let dialer = RusshDialer::new(key.clone());
    for retain_writer in [false, true] {
        let server = Server::start(&key, Script::default()).await;
        let stream = dial(&dialer, &server.endpoint).await.unwrap();
        let writer = if retain_writer {
            drop(stream.close);
            Some(stream.writer)
        } else {
            drop(stream);
            None
        };
        assert!(server.finish().await.contains(&Event::TcpClosed));
        if let Some(mut writer) = writer {
            assert!(writer.write_all(b"late write").await.is_err());
        }
    }
}

#[test]
fn classify_keeps_stderr_or_the_handshake_sentence_with_the_host() {
    let dialer = RusshDialer::new(Arc::new(SoftwareSigner::generate()));
    let target = Target {
        route: Route::Lan,
        host: "studio".into(),
    };
    for (outcome, stderr, detail) in [
        (
            HandshakeFailure::TimedOut,
            "agent stalled",
            "studio: agent stalled",
        ),
        (
            HandshakeFailure::Closed,
            "agent exited",
            "studio: agent exited",
        ),
        (
            HandshakeFailure::Invalid,
            "",
            "studio: The host sent an invalid StatGlass greeting.",
        ),
    ] {
        let error = dialer.classify(&DialFailure {
            target: &target,
            stderr,
            outcome,
        });
        match error {
            RemoteError::Timeout(message) if outcome == HandshakeFailure::TimedOut => {
                assert_eq!(message, detail)
            }
            RemoteError::Transport(message) if outcome != HandshakeFailure::TimedOut => {
                assert_eq!(message, detail)
            }
            wrong => panic!("wrong classification: {wrong:?}"),
        }
    }
}

#[test]
fn keepalive_defaults_match_the_desktop() {
    let config = RusshConfig::default();
    assert_eq!(config.keepalive_interval, Duration::from_secs(15));
    assert_eq!(config.keepalive_max, 3);
}

#[tokio::test]
async fn unanswered_keepalives_close_the_session_only_when_a_miss_limit_is_set() {
    let key = Arc::new(SoftwareSigner::generate());
    let mut limited = Server::start(&key, Script::default()).await;
    let mut unlimited = Server::start(&key, Script::default()).await;
    let config = RusshConfig {
        keepalive_interval: Duration::from_millis(60),
        keepalive_max: 1,
        ..Default::default()
    };
    let dialer = RusshDialer::with_config(key.clone(), config);
    let mut limited_stream = dial(&dialer, &limited.endpoint).await.unwrap();
    limited.mute_replies();
    let dialer = RusshDialer::with_config(
        key,
        RusshConfig {
            keepalive_max: 0,
            ..config
        },
    );
    let mut unlimited_stream = dial(&dialer, &unlimited.endpoint).await.unwrap();
    unlimited.mute_replies();

    let error = timeout(Duration::from_secs(1), limited_stream.reader.read_u8())
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
    assert!(limited.finish().await.contains(&Event::TcpClosed));
    // The default of three misses would already close this connection too.
    assert!(
        timeout(
            Duration::from_millis(300),
            unlimited_stream.reader.read_u8()
        )
        .await
        .is_err()
    );
    drop(unlimited_stream);
    assert!(unlimited.finish().await.contains(&Event::TcpClosed));
}
