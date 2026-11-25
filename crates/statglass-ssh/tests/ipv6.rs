use statglass_session::Dialer;
use statglass_ssh::{EphemeralSigner, RusshDialer, Signer, authorized_key_line};
use std::{io, sync::Arc, time::Duration};
use tokio::{io::AsyncReadExt, net::TcpListener, time::timeout};

#[cfg(test)]
#[path = "support/server.rs"]
pub mod server;

#[tokio::test]
async fn ssh_handshake_over_an_ipv6_loopback_literal() {
    let listener = match TcpListener::bind("[::1]:0").await {
        Ok(listener) => listener,
        Err(error) if ipv6_loopback_unavailable(&error) => {
            eprintln!("skipping IPv6 SSH handshake: cannot bind [::1]: {error}");
            return;
        }
        Err(error) => panic!("bind IPv6 SSH fixture: {error}"),
    };
    let key = Arc::new(EphemeralSigner::from_scalar(&[7; 32]).unwrap());
    let public = authorized_key_line(key.public_key().await.unwrap(), "fixture").unwrap();
    let server = server::Server::start_with_listener(
        listener,
        &public,
        server::Script {
            stdout: b"hello".to_vec(),
            ..Default::default()
        },
    );
    let target = &server.endpoint.targets[0];
    assert_eq!(target.host, "::1");
    let mut stream = RusshDialer::new(key)
        .dial(&server.endpoint, target)
        .await
        .expect("open an authenticated SSH command stream over IPv6");
    let mut greeting = [0; 5];
    timeout(
        Duration::from_secs(1),
        stream.reader.read_exact(&mut greeting),
    )
    .await
    .expect("receive SSH command output within one second")
    .unwrap();
    assert_eq!(&greeting, b"hello");
    stream.close.close().await;
    server.finish().await;
}

fn ipv6_loopback_unavailable(error: &io::Error) -> bool {
    match error.raw_os_error() {
        #[cfg(unix)]
        Some(libc::EAFNOSUPPORT | libc::EPROTONOSUPPORT) => true,
        _ => matches!(
            error.kind(),
            io::ErrorKind::AddrNotAvailable | io::ErrorKind::Unsupported
        ),
    }
}
