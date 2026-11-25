//! Remote command contracts; wire names and field shapes stay stable.
use super::*;
pub use statglass_ipc::status::{
    RemoteFailureKind, RemoteRoute, RemoteRouteFailure, RemoteState, RemoteSync,
};
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
pub struct RemoteHostConfig {
    pub id: String,
    pub name: String,
    pub lan: Option<String>,
    pub tailscale: Option<String>,
    pub enabled: bool,
    pub mirror_budget_mb: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
pub struct RemoteHostStatus {
    pub state: RemoteState,
    pub route: Option<RemoteRoute>,
    pub last_seen_ms: Option<f64>,
    /// End of the newest mirrored history bucket persisted on disk (remote host clock).
    /// Survives app restarts so offline views know whether saved history exists.
    pub synced_through_ms: Option<f64>,
    pub error: Option<String>,
    pub failure_kind: Option<RemoteFailureKind>,
    /// Per-route causes of the last failure; empty while connected or when the
    /// failure was not specific to a route.
    pub route_failures: Vec<RemoteRouteFailure>,
    /// This Mac's wall-clock ms of the next automatic attempt, when one is scheduled.
    pub next_attempt_ms: Option<f64>,
    /// Consecutive failed attempts since the last connection.
    pub attempt: u32,
    /// A connection attempt is in flight.
    pub dialing: bool,
    /// This Mac is offline; the host reconnects when the network changes.
    pub waiting_for_network: bool,
    pub sync: RemoteSync,
    pub clock_offset_ms: f64,
    pub vitals: HostVitals,
    pub rr: Option<statglass_remote::rr::RrJob>,
    pub update: Option<AgentUpdateProgress>,
    pub last_update_failure: Option<AgentUpdateFailure>,
    /// The version the host last reported (`Hello.app_version`), kept across restarts.
    pub agent_version: Option<String>,
    /// How the host's StatGlass compares with the one this Mac can install (D-123).
    pub agent_update: AgentUpdate,
    /// The id the host answered with when it is not the paired one. The host list
    /// offers "Re-pair as a new host" (D-116).
    pub identity_changed: Option<String>,
}
impl Default for RemoteHostStatus {
    fn default() -> Self {
        Self {
            state: RemoteState::Offline,
            route: None,
            last_seen_ms: None,
            synced_through_ms: None,
            error: None,
            failure_kind: None,
            route_failures: Vec::new(),
            next_attempt_ms: None,
            attempt: 0,
            dialing: false,
            waiting_for_network: false,
            sync: RemoteSync::Idle,
            clock_offset_ms: 0.0,
            vitals: HostVitals::default(),
            rr: None,
            update: None,
            last_update_failure: None,
            agent_version: None,
            agent_update: AgentUpdate::Unknown,
            identity_changed: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdatePhase {
    Queued,
    Probing,
    Uploading {
        #[specta(type = statglass_schema::JsSafeInt)]
        sent_bytes: u64,
        #[specta(type = statglass_schema::JsSafeInt)]
        total_bytes: u64,
    },
    Installing,
    Restarting,
    Reconnecting,
    Unknown,
}

impl<'de> Deserialize<'de> for UpdatePhase {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(tag = "kind", rename_all = "snake_case")]
        enum Input {
            Queued,
            Probing,
            Uploading {
                sent_bytes: u64,
                total_bytes: u64,
            },
            Installing,
            Restarting,
            Reconnecting,
            #[serde(other)]
            Unknown,
        }
        Ok(match Input::deserialize(deserializer)? {
            Input::Queued => Self::Queued,
            Input::Probing => Self::Probing,
            Input::Uploading {
                sent_bytes,
                total_bytes,
            } => Self::Uploading {
                sent_bytes,
                total_bytes,
            },
            Input::Installing => Self::Installing,
            Input::Restarting => Self::Restarting,
            Input::Reconnecting => Self::Reconnecting,
            Input::Unknown => Self::Unknown,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct AgentUpdateProgress {
    pub target: String,
    pub phase: UpdatePhase,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct AgentUpdateFailure {
    pub via: AgentUpdateVia,
    pub target: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, specta::Type, tauri_specta::Event)]
pub struct RemoteHostsChanged {}
/// How a host gets this Mac's version: a Linux agent is pushed in place ("Update
/// agent"); a Mac is reinstalled from Add host.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum AgentUpdateVia {
    Push,
    AddHost,
}

/// A host's installed StatGlass against the version this Mac bundles, which is the newest
/// this Mac can install there (D-123).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentUpdate {
    /// No version was ever reported.
    Unknown,
    UpToDate {
        installed: String,
    },
    Available {
        installed: String,
        target: String,
        via: AgentUpdateVia,
    },
    /// The host's protocol is incompatible: it cannot reconnect until it is upgraded
    /// from this Mac (D-119).
    Required {
        installed: String,
        target: String,
        via: AgentUpdateVia,
    },
    /// The host is ahead; it is never downgraded. Updating this Mac catches up.
    NewerThanThis {
        installed: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
pub struct RemoteHostRecord {
    pub config: RemoteHostConfig,
    pub os: statglass_schema::OsKind,
    pub status: RemoteHostStatus,
}

/// What answered at an SSH alias, which decides the setup path.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RemoteHostKind {
    /// Another Mac, running StatGlass.app (D-104).
    Mac,
    /// A Linux host, running the headless agent (D-116).
    Linux,
}

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
pub struct RemoteHostPreparation {
    pub kind: RemoteHostKind,
    pub installed: bool,
    /// Connecting needs no install or update.
    pub compatible: bool,
    /// The installed agent is newer than this app: it connects as it is and is never
    /// replaced with this build's older one. Linux only; always false for a Mac.
    pub newer_installed: bool,
    pub host_id: Option<String>,
    pub name: String,
    pub message: Option<String>,
    /// What installing on a Linux host involves; `None` for a Mac.
    pub linux: Option<LinuxPreparation>,
}

/// How the agent runs on a Linux host: root installs a system service, anyone else a
/// user service (D-116).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RemoteAgentLayout {
    System,
    User,
}

/// Whether the agent's login can use the Docker socket to name containers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RemoteDockerAccess {
    /// No Docker socket on the host.
    Absent,
    /// There is a socket this login cannot use; containers show by short id.
    Unreadable,
    Readable,
}

/// The Linux disclosure: what setup will put on the host and what it found there.
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
pub struct LinuxPreparation {
    pub layout: RemoteAgentLayout,
    /// The SSH login the agent installs for.
    pub user: String,
    /// os-release `PRETTY_NAME`.
    pub distro: Option<String>,
    /// `uname -r`.
    pub kernel: Option<String>,
    /// `uname -m`.
    pub arch: String,
    pub systemd_version: Option<u32>,
    /// A user service keeps running after logout only with lingering on. Always true
    /// for the system layout.
    pub linger_ok: bool,
    /// `getenforce`: `Enforcing`, `Permissive` or `Disabled`; `None` without SELinux.
    pub selinux: Option<String>,
    pub binary_path: String,
    pub data_dir: String,
    /// Free space on the data directory's volume.
    #[specta(type = Option<statglass_schema::JsSafeInt>)]
    pub free_bytes: Option<u64>,
    /// The low-disk reserve plus the history budget; `None` when an agent is already
    /// installed (its history already holds its share) or the volume size is unknown.
    #[specta(type = Option<statglass_schema::JsSafeInt>)]
    pub needed_bytes: Option<u64>,
    /// The agent's history size limit (decimal MB).
    pub budget_mb: u32,
    /// The installed agent's version, when one is installed.
    pub existing_version: Option<String>,
    /// Whether the agent can use the Docker socket to name containers.
    pub docker: RemoteDockerAccess,
    /// Non-blocking notes from the probe (the linger command for a user service).
    pub warnings: Vec<String>,
    /// The saved host already using the installed agent's id. Adding needs a new
    /// identity first (`reset_remote_host_identity`).
    pub duplicate_of: Option<String>,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
pub struct RemoteSshHostTrust {
    pub token: String,
    pub alias: String,
    pub hostname: String,
    pub port: u16,
    pub fingerprints: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RemoteSshConfigStatus {
    Missing,
    Present,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_host_status_json_stays_flat() {
        let host = HostId(uuid::Uuid::nil());
        let status = RemoteHostStatus {
            state: RemoteState::Error,
            route: Some(RemoteRoute::Lan),
            last_seen_ms: Some(1000.0),
            synced_through_ms: Some(900.0),
            error: Some("timed out".into()),
            failure_kind: Some(RemoteFailureKind::Timeout),
            route_failures: vec![RemoteRouteFailure {
                route: RemoteRoute::Tailscale,
                kind: RemoteFailureKind::Refused,
            }],
            next_attempt_ms: Some(2000.0),
            attempt: 3,
            dialing: true,
            waiting_for_network: true,
            sync: RemoteSync::Unavailable,
            clock_offset_ms: -25.0,
            vitals: HostVitals {
                cpu_pct: Some(12.5),
                memory_pct: Some(50.0),
                load_1m: Some(1.5),
                cores: Some(4),
                memory_pressure: Some(super::super::vitals::MemoryPressure::Stall {
                    some_pct: 2.5,
                }),
                disk_used_bytes: Some(60),
                disk_free_bytes: Some(40),
                disk_total_bytes: Some(100),
                disk_low: true,
                net_rx_bps: Some(20.0),
                net_tx_bps: Some(10.0),
            },
            rr: Some(statglass_remote::rr::RrJob {
                command: Some("build".into()),
                user: "alice".into(),
                client_hostname: "client".into(),
                started_ms: 800,
                peers: vec![host],
            }),
            update: Some(AgentUpdateProgress {
                target: "2.0".into(),
                phase: UpdatePhase::Uploading {
                    sent_bytes: 10,
                    total_bytes: 20,
                },
            }),
            last_update_failure: Some(AgentUpdateFailure {
                via: AgentUpdateVia::Push,
                target: "2.0".into(),
                message: "upload failed".into(),
            }),
            agent_version: Some("1.0".into()),
            agent_update: AgentUpdate::Available {
                installed: "1.0".into(),
                target: "2.0".into(),
                via: AgentUpdateVia::Push,
            },
            identity_changed: Some("other-host".into()),
        };
        let expected = concat!(
            r#"{"state":"error","route":"lan","last_seen_ms":1000.0,"synced_through_ms":900.0,"error":"timed out","failure_kind":"timeout","#,
            r#""route_failures":[{"route":"tailscale","kind":"refused"}],"next_attempt_ms":2000.0,"attempt":3,"dialing":true,"waiting_for_network":true,"sync":"unavailable","clock_offset_ms":-25.0,"#,
            r#""vitals":{"cpu_pct":12.5,"memory_pct":50.0,"load_1m":1.5,"cores":4,"memory_pressure":{"kind":"stall","some_pct":2.5},"disk_used_bytes":60,"disk_free_bytes":40,"disk_total_bytes":100,"disk_low":true,"net_rx_bps":20.0,"net_tx_bps":10.0},"#,
            r#""rr":{"command":"build","user":"alice","client_hostname":"client","started_ms":800,"peers":["00000000-0000-0000-0000-000000000000"]},"#,
            r#""update":{"target":"2.0","phase":{"kind":"uploading","sent_bytes":10,"total_bytes":20}},"last_update_failure":{"via":"push","target":"2.0","message":"upload failed"},"#,
            r#""agent_version":"1.0","agent_update":{"kind":"available","installed":"1.0","target":"2.0","via":"push"},"identity_changed":"other-host"}"#,
        );
        assert_eq!(serde_json::to_string(&status).unwrap(), expected);
        let decoded: RemoteHostStatus = serde_json::from_str(expected).unwrap();
        assert_eq!(serde_json::to_string(&decoded).unwrap(), expected);
    }
}
