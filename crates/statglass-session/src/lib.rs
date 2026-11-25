#![cfg_attr(test, allow(clippy::too_many_lines))]
//! The client side of a StatGlass remote session, shared by the desktop and the phone.
//! It spawns no processes; each app supplies its own [`Dialer`].
mod calls;
mod clock;
pub mod codec;
pub mod command;
#[cfg(feature = "conformance")]
pub mod conformance;
mod connect;
mod dialer;
mod endpoint;
mod error;
pub mod handover;
mod mirror;
mod mirror_error;
pub mod mirror_policy;
mod mirror_sink;
pub mod network;
mod pages;
pub mod pairing;
mod recent_rows;
mod session;
mod source;
#[cfg(test)]
mod test_support;
pub mod wire;

pub use clock::HostClock;
pub use command::{ForcedToken, RemoteCommand};
pub use connect::{DIAL_TIMEOUT_MS, HANDSHAKE_TIMEOUT, PROMOTION_DEBOUNCE, ROUTE_GRACE, connect};
pub use dialer::{
    AGENT_COMMAND_NOT_ALLOWED, AGENT_NOT_RUNNING, APP_NOT_RUNNING, BoxFuture, Close, DialFailure,
    DialedStream, Dialer, HELPER_COMMAND_NOT_ALLOWED, HandshakeFailure, MONITORING_OFF,
    STDERR_TAIL_BYTES, StderrTail, marker_error,
};
pub use endpoint::{Endpoint, MAX_TARGETS, PinnedHostKey, Route, Target};
pub use error::{RemoteError, Result, RouteError, UnreachableKind};
pub use mirror::{AlertListener, Mirror, MirrorAlertBatch, SyncWatermark};
pub use mirror_error::MirrorError;
pub use mirror_policy::MirrorPolicy;
pub use mirror_sink::MirrorSink;
pub use pages::{page_from_wire, page_to_wire};
pub use pairing::pair;
pub use session::SshSession;
pub use source::{
    ConnectionFailureKind, ConnectionStatus, IncompatibleSide, NETWORK_CHANGE_PROBE, RemoteSource,
    RouteFailure, SourceOptions, StatusCallback,
};
