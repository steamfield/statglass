//! The client side of a StatGlass remote session, shared by the desktop and the phone:
//! the endpoint and dialer seam, the handshake and route race, and the remote command.
//! It spawns no processes; each app supplies its own [`Dialer`].
pub mod command;
#[cfg(feature = "conformance")]
pub mod conformance;
mod connect;
mod dialer;
mod endpoint;
mod error;
mod session;

pub use command::RemoteCommand;
pub use connect::{DIAL_TIMEOUT_MS, HANDSHAKE_TIMEOUT, PROMOTION_DEBOUNCE, ROUTE_GRACE, connect};
pub use dialer::{
    AGENT_NOT_RUNNING, BoxFuture, Close, DialFailure, DialedStream, Dialer, HandshakeFailure,
    STDERR_TAIL_BYTES, StderrTail, marker_error,
};
pub use endpoint::{Endpoint, MAX_TARGETS, PinnedHostKey, Route, Target};
pub use error::{RemoteError, Result, RouteError, UnreachableKind};
pub use session::SshSession;
