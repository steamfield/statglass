#![cfg_attr(test, allow(clippy::too_many_lines))]
//! Persistent, direct SSH sessions. No network listener, collector, or Tauri dependency.
pub mod agent_install;
pub mod agent_layout;
mod calls;
mod clock;
mod codec;
pub mod control;
mod host_queries;
mod host_server;
pub mod install;
mod mirror;
mod mirror_error;
mod mirror_sink;
pub mod network;
pub mod rr;
pub use mirror_error::MirrorError;
mod pages;
pub use mirror::{Mirror, SyncWatermark};
mod server;
mod socket;
mod source;
mod stdio;
#[cfg(test)]
mod test_support;
mod transport;
pub mod trust;

pub use agent_layout::{AgentEnv, AgentLayout, AgentPaths};
pub use clock::HostClock;
pub use host_server::{HostServer, InterestSet, ServedHost};
pub use mirror_sink::MirrorSink;
pub use pages::{page_from_wire, page_to_wire};
pub use server::status_to_wire;
pub use server::{
    ServerProvider, headline_metrics, headline_series, serve_connection, serve_metrics,
};
pub use socket::{
    ControlRequest, ControlResponse, SocketPaths, bind_private, control_request, same_uid,
    serve_control,
};
pub use source::{
    ConnectionFailureKind, ConnectionStatus, RemoteSource, RouteFailure, StatusCallback,
};
pub use statglass_proto::RemoteInterest;
pub use statglass_session::{
    AGENT_NOT_RUNNING, DIAL_TIMEOUT_MS, Dialer, Endpoint, PinnedHostKey, RemoteCommand,
    RemoteError, Result, Route, RouteError, SshSession, Target, UnreachableKind,
};
pub use stdio::stdio_bridge;
pub use transport::{EndpointConfig, OpenSshDialer, connect, ssh_command};
