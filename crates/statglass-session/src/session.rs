//! An open, negotiated session to a host: the stream a dialer produced, after the
//! StatGlass handshake succeeded on it.
use crate::{Close, DialedStream, Route, Target};
use statglass_proto::{Hello, Negotiated};
use std::pin::Pin;
use tokio::io::{AsyncRead, AsyncWrite};

pub struct SshSession {
    pub hello: Hello,
    pub negotiated: Negotiated,
    /// The winning target's route.
    pub route: Route,
    pub target: Target,
    pub reader: Pin<Box<dyn AsyncRead + Send>>,
    pub writer: Pin<Box<dyn AsyncWrite + Send>>,
    close: Box<dyn Close>,
}

impl SshSession {
    /// The session on `stream`, which reached `target` and answered with `hello`. The
    /// stream's stderr tail is not kept: a live session's stderr is noise.
    pub fn new(hello: Hello, negotiated: Negotiated, target: Target, stream: DialedStream) -> Self {
        Self {
            hello,
            negotiated,
            route: target.route,
            target,
            reader: stream.reader,
            writer: stream.writer,
            close: stream.close,
        }
    }

    /// Closes the transport through its dialer's orderly path.
    pub async fn close(self) {
        self.close.close().await;
    }

    /// A LAN session over an in-memory stream that already answered with `hello`, for
    /// tests that play the host's side of the stream.
    #[cfg(any(test, feature = "conformance"))]
    #[doc(hidden)]
    pub fn test(stream: tokio::io::DuplexStream, hello: Hello) -> Self {
        let (reader, writer) = tokio::io::split(stream);
        let negotiated = statglass_proto::negotiate(
            &statglass_proto::Offer::local(statglass_proto::local_features()),
            &statglass_proto::Offer::from(&hello),
        )
        .expect("test Hellos come from this build, so they negotiate");
        let target = Target {
            route: Route::Lan,
            host: "test".into(),
        };
        let stream = DialedStream {
            reader: Box::pin(reader),
            writer: Box::pin(writer),
            stderr: crate::StderrTail::default(),
            close: Box::new(NothingToClose),
        };
        Self::new(hello, negotiated, target, stream)
    }
}

/// The in-memory stream of [`SshSession::test`] has no transport behind it.
#[cfg(any(test, feature = "conformance"))]
struct NothingToClose;

#[cfg(any(test, feature = "conformance"))]
impl Close for NothingToClose {
    fn close(self: Box<Self>) -> crate::BoxFuture<'static, ()> {
        Box::pin(async {})
    }
}
