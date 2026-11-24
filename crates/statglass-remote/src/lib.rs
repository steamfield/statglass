#![cfg_attr(test, allow(clippy::too_many_lines))]
//! Persistent, direct SSH sessions. No network listener, collector, or Tauri dependency.
pub mod agent_install;
pub mod agent_layout;
mod answering;
pub mod control;
mod host_queries;
mod host_server;
pub mod install;
pub mod rr;
mod server;
mod socket;
mod stdio;
#[cfg(test)]
mod test_support;
mod transport;
pub mod trust;

pub use agent_layout::{AgentEnv, AgentLayout, AgentPaths};
pub use host_server::{HostServer, InterestSet, ServedHost};
pub use server::{
    ServerProvider, headline_metrics, headline_series, serve_connection, serve_metrics,
};
pub use socket::{
    ControlRequest, ControlResponse, SocketPaths, bind_private, control_request, same_uid,
    serve_control,
};
pub use statglass_proto::RemoteInterest;
pub(crate) use statglass_session::codec;
pub use statglass_session::wire::status_to_wire;
pub use statglass_session::{
    AGENT_NOT_RUNNING, ConnectionFailureKind, ConnectionStatus, DIAL_TIMEOUT_MS, Dialer, Endpoint,
    HostClock, Mirror, MirrorError, MirrorSink, PinnedHostKey, RemoteCommand, RemoteError,
    RemoteSource, Result, Route, RouteError, RouteFailure, SshSession, StatusCallback,
    SyncWatermark, Target, UnreachableKind, network, page_from_wire, page_to_wire,
};
pub use stdio::stdio_bridge;
pub use transport::{EndpointConfig, OpenSshDialer, connect, ssh_command};
