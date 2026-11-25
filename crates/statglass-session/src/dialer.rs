//! The dialer seam: how a session opens its byte stream to a host. OpenSSH
//! (`statglass-remote`) and russh (`statglass-ssh`) implement [`Dialer`]; the shared
//! handshake and route race in [`connect`](crate::connect) sit on top.
use crate::{Endpoint, RemoteError, Result, Target};
use statglass_schema::lock::LockExt;
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};
use tokio::io::{AsyncRead, AsyncWrite};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait Dialer: Send + Sync + 'static {
    /// Opens the transport to `target` and starts `endpoint.command`. SSH-level failures
    /// (connect, host key, auth) come back already classified.
    fn dial<'a>(
        &'a self,
        endpoint: &'a Endpoint,
        target: &'a Target,
    ) -> BoxFuture<'a, Result<DialedStream>>;

    /// A stream that ended or stalled before the StatGlass Hello, after `close` finished.
    fn classify(&self, failure: &DialFailure<'_>) -> RemoteError;
}

/// The remote command's stdio, as a dialer opened it.
///
/// Dropping it must release the transport too (OpenSSH: kill_on_drop; russh: drop the
/// handle and abort its task). `close` is the orderly path.
pub struct DialedStream {
    pub reader: Pin<Box<dyn AsyncRead + Send>>,
    pub writer: Pin<Box<dyn AsyncWrite + Send>>,
    pub stderr: StderrTail,
    pub close: Box<dyn Close>,
}

/// The orderly shutdown of a dialed transport.
pub trait Close: Send + 'static {
    fn close(self: Box<Self>) -> BoxFuture<'static, ()>;
}

/// The most remote stderr a dial keeps for classification.
pub const STDERR_TAIL_BYTES: usize = 8192;

/// The start of the remote command's stderr, capped at [`STDERR_TAIL_BYTES`]. Clones
/// share one buffer, so the dialer's pump and the handshake see the same bytes.
#[derive(Clone, Default)]
pub struct StderrTail(Arc<Mutex<Vec<u8>>>);

impl StderrTail {
    /// Appends what still fits under the cap and drops the rest.
    pub fn push(&self, bytes: &[u8]) {
        let mut buffer = self.0.lock_ok();
        let keep = bytes
            .len()
            .min(STDERR_TAIL_BYTES.saturating_sub(buffer.len()));
        buffer.extend_from_slice(bytes.get(..keep).unwrap_or_default());
    }

    /// The captured text, lossily decoded and trimmed.
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock_ok())
            .trim()
            .to_string()
    }
}

/// A dial that produced a stream but no StatGlass Hello.
pub struct DialFailure<'a> {
    pub target: &'a Target,
    /// [`StderrTail::text`] once the stream was closed.
    pub stderr: &'a str,
    pub outcome: HandshakeFailure,
}

/// How the wait for the Hello ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HandshakeFailure {
    /// No Hello within the handshake timeout.
    TimedOut,
    /// The stream ended before a whole frame arrived.
    Closed,
    /// Reading the stream failed.
    Io(std::io::ErrorKind),
    /// The first frame did not decode.
    Invalid,
    /// The first frame decoded but was not a Hello.
    NotHello,
}

impl HandshakeFailure {
    /// The plain sentence a failure with no stderr reads as.
    pub fn sentence(self) -> &'static str {
        match self {
            Self::TimedOut => "The host did not answer in time.",
            Self::Closed | Self::Io(std::io::ErrorKind::UnexpectedEof) => {
                "The connection closed before StatGlass could start on the host."
            }
            Self::Io(_) => "The connection failed while StatGlass was starting on the host.",
            Self::Invalid => "The host sent an invalid StatGlass greeting.",
            Self::NotHello => "The host did not send a StatGlass greeting.",
        }
    }
}

/// The line `statglass-agent serve` prints to stderr when its daemon is not running.
pub const AGENT_NOT_RUNNING: &str = "statglass-agent: not running";

/// The line the Mac's `statglass-remote-helper` prints to stderr when the app is not
/// running there. Recognized by [`marker_error`] from phase 3 lane c.
pub const APP_NOT_RUNNING: &str = "statglass-remote-helper: not running";

/// The line the Mac's `statglass-remote-helper` prints to stderr when the app runs with
/// remote monitoring off. Recognized by [`marker_error`] from phase 3 lane c.
pub const MONITORING_OFF: &str = "statglass-remote-helper: remote monitoring off";

/// Marker lines the shared handshake checks before asking the dialer (phase 5 adds more).
pub fn marker_error(target: &Target, stderr: &str) -> Option<RemoteError> {
    stderr
        .lines()
        .any(|line| line.trim() == AGENT_NOT_RUNNING)
        .then(|| RemoteError::AgentNotRunning(target.host.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Route;

    #[test]
    fn stderr_tail_keeps_only_the_first_bytes_across_clones() {
        let tail = StderrTail::default();
        let pump = tail.clone();
        pump.push(b"  ssh: connect to host studio");
        pump.push(&[b'x'; STDERR_TAIL_BYTES]);
        pump.push(b"never kept");
        let text = tail.text();
        assert_eq!(text.len(), STDERR_TAIL_BYTES - 2);
        assert!(text.starts_with("ssh: connect to host studio"));
        assert!(!text.contains("never kept"));
    }

    #[test]
    fn only_a_whole_marker_line_reads_as_a_stopped_agent() {
        let target = Target {
            route: Route::Lan,
            host: "server".into(),
        };
        let noisy = "Warning: Permanently added\nstatglass-agent: not running\n";
        assert!(matches!(
            marker_error(&target, noisy),
            Some(RemoteError::AgentNotRunning(host)) if host == "server"
        ));
        assert!(marker_error(&target, "sh: statglass-agent: not found").is_none());
        assert!(marker_error(&target, "").is_none());
    }

    #[test]
    fn handshake_failures_use_plain_sentences() {
        let eof = HandshakeFailure::Io(std::io::ErrorKind::UnexpectedEof);
        assert_eq!(eof.sentence(), HandshakeFailure::Closed.sentence());
        assert_eq!(
            HandshakeFailure::Io(std::io::ErrorKind::ConnectionReset).sentence(),
            "The connection failed while StatGlass was starting on the host."
        );
    }
}
