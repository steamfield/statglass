//! What `serve` prints when it cannot reach the app's metrics socket, so the phone and
//! the desktop tell "StatGlass isn't running" from "remote monitoring is off"
//! (`statglass_session::APP_NOT_RUNNING` and `MONITORING_OFF`).
use statglass_remote::{
    ControlRequest, RemoteError, SessionScope, SocketPaths, control_request,
    scope::{APP_NOT_RUNNING, MONITORING_OFF},
};
use tokio::net::UnixStream;

/// Bridges the metrics socket, or prints the marker for why it is unreachable and
/// returns exit 3.
pub async fn serve_or_marker(paths: &SocketPaths, scope: SessionScope) -> std::io::Result<i32> {
    let error = match UnixStream::connect(&paths.metrics).await {
        Ok(stream) => return scope.bridge_stdio(stream).await.map(|()| 0),
        Err(error) => error,
    };
    match unavailable_marker(paths).await {
        Ok(Some(marker)) => eprintln!("{marker}"),
        Ok(None) => eprintln!("statglass-remote-helper: connecting to metrics socket: {error}"),
        Err(error) => eprintln!("statglass-remote-helper: checking monitoring status: {error}"),
    }
    Ok(3)
}

async fn unavailable_marker(paths: &SocketPaths) -> statglass_remote::Result<Option<&'static str>> {
    // control_request caps the entire status round trip at ten seconds.
    match control_request(&paths.control, &ControlRequest::Status).await {
        Ok(status) if status.allow_remote_monitoring == Some(false) => Ok(Some(MONITORING_OFF)),
        Err(RemoteError::Io(error))
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
            ) =>
        {
            Ok(Some(APP_NOT_RUNNING))
        }
        Ok(_) => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::UnixListener,
    };

    #[tokio::test]
    async fn unreachable_control_means_app_not_running() {
        let dir = tempfile::tempdir_in("/tmp").unwrap();
        let paths = SocketPaths::new(dir.path());
        assert_eq!(
            unavailable_marker(&paths).await.unwrap(),
            Some("statglass-remote-helper: not running")
        );
    }

    #[tokio::test]
    async fn only_an_explicitly_disabled_status_means_monitoring_off() {
        let dir = tempfile::tempdir_in("/tmp").unwrap();
        let paths = SocketPaths::new(dir.path());
        std::fs::create_dir_all(paths.control.parent().unwrap()).unwrap();
        let listener = UnixListener::bind(&paths.control).unwrap();
        for (enabled, expected) in [
            (
                Some(false),
                Some("statglass-remote-helper: remote monitoring off"),
            ),
            (Some(true), None),
            (None, None),
        ] {
            let respond = async {
                let (mut conn, _) = listener.accept().await.unwrap();
                let size = conn.read_u32().await.unwrap();
                let mut request = vec![0; size as usize];
                conn.read_exact(&mut request).await.unwrap();
                assert_eq!(request, br#"{"operation":"status"}"#);
                let response = serde_json::to_vec(&serde_json::json!({
                    "ok":true, "message":"", "host":null, "allow_remote_monitoring":enabled,
                }))
                .unwrap();
                conn.write_u32(response.len() as u32).await.unwrap();
                conn.write_all(&response).await.unwrap();
            };
            let (marker, ()) = tokio::time::timeout(std::time::Duration::from_secs(3), async {
                tokio::join!(unavailable_marker(&paths), respond)
            })
            .await
            .unwrap();
            assert_eq!(marker.unwrap(), expected);
        }
    }

    #[tokio::test]
    async fn a_malformed_response_from_a_reachable_control_socket_is_an_error() {
        let dir = tempfile::tempdir_in("/tmp").unwrap();
        let paths = SocketPaths::new(dir.path());
        std::fs::create_dir_all(paths.control.parent().unwrap()).unwrap();
        let listener = UnixListener::bind(&paths.control).unwrap();
        let respond = async {
            let (mut conn, _) = listener.accept().await.unwrap();
            let size = conn.read_u32().await.unwrap();
            let mut request = vec![0; size as usize];
            conn.read_exact(&mut request).await.unwrap();
            conn.write_u32(4).await.unwrap();
            conn.write_all(b"oops").await.unwrap();
        };
        let (marker, ()) = tokio::join!(unavailable_marker(&paths), respond);
        assert!(matches!(marker, Err(RemoteError::Protocol(_))));
    }
}
