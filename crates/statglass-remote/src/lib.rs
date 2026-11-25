#![cfg_attr(test, allow(clippy::too_many_lines))]
//! Persistent, direct SSH sessions. No network listener, collector, or Tauri dependency.
pub mod addresses;
pub mod agent_install;
pub mod agent_layout;
mod answering;
pub mod authorized_keys;
pub mod control;
pub mod device_keys;
pub mod device_seen;
pub mod effective_user;
pub mod history_query;
mod host_queries;
mod host_server;
pub mod install;
pub mod pairing;
pub mod rr;
pub mod scope;
mod server;
mod socket;
mod stdio;
#[cfg(test)]
mod test_support;
mod transport;
pub mod trust;

pub use agent_layout::{AgentEnv, AgentLayout, AgentPaths};
pub use authorized_keys::AuthorizedKeys;
pub use device_keys::{DeviceKeys, DeviceKeysError, DeviceTag, EcdsaP256Public, PairedDevice};
pub use device_seen::DeviceSeenLog;
pub use host_server::{HostServer, InterestSet, ServedHost};
pub use pairing::{PairCommands, PairingError, PairingHost};
pub use scope::{
    MAX_PREFACE_BYTES, PREFACE_MAGIC, ScopeError, SessionScope, encode_preface, read_preface,
};
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
    AGENT_COMMAND_NOT_ALLOWED, AGENT_NOT_RUNNING, ConnectionFailureKind, ConnectionStatus,
    DIAL_TIMEOUT_MS, Dialer, Endpoint, HELPER_COMMAND_NOT_ALLOWED, HostClock, Mirror, MirrorError,
    MirrorSink, PinnedHostKey, RemoteCommand, RemoteError, RemoteSource, Result, Route, RouteError,
    RouteFailure, SshSession, StatusCallback, SyncWatermark, Target, UnreachableKind, network,
    page_from_wire, page_to_wire,
};
pub use statglass_session::{MAX_TARGETS, command};
pub use stdio::stdio_bridge;
pub use transport::{EndpointConfig, OpenSshDialer, connect, ssh_command};
