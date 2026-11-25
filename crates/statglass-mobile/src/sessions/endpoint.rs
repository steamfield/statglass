use statglass_ipc::mobile::{MobileCommand, MobileHost};
use statglass_ipc::status::RemoteRoute;
use statglass_schema::{HostInfo, HostRecord, OsKind};
use statglass_session::{Endpoint, ForcedToken, PinnedHostKey, RemoteCommand, Route, Target};

pub(super) fn endpoint(host: &MobileHost) -> Endpoint {
    Endpoint {
        targets: host
            .targets
            .iter()
            .map(|target| Target {
                route: match target.route {
                    RemoteRoute::Lan => Route::Lan,
                    RemoteRoute::Tailscale => Route::Tailscale,
                },
                host: target.host.clone(),
            })
            .collect(),
        port: host.port,
        user: Some(host.user.clone()),
        host_keys: host
            .host_keys
            .iter()
            .map(|key| PinnedHostKey {
                algorithm: key.algorithm.clone(),
                sha256: key.sha256.clone(),
            })
            .collect(),
        command: match &host.command {
            MobileCommand::Restricted => RemoteCommand::Restricted {
                forced: ForcedToken::Serve,
            },
            MobileCommand::MacHelper { path } => RemoteCommand::MacHelper(path.clone()),
            MobileCommand::Agent {
                bin,
                system,
                socket,
            } => RemoteCommand::Agent {
                bin: bin.clone(),
                system: *system,
                socket: socket.clone(),
            },
        },
    }
}

pub(super) fn record(host: &MobileHost) -> HostRecord {
    HostRecord {
        id: host.id,
        is_local: false,
        display_name: host.name.clone(),
        info: HostInfo {
            os: match host.command {
                MobileCommand::MacHelper { .. } => OsKind::MacOs,
                MobileCommand::Agent { .. } => OsKind::Linux,
                MobileCommand::Restricted => OsKind::Unknown,
            },
            os_version: String::new(),
            model: None,
            chip: None,
            chip_known: false,
            cpu_topology: Vec::new(),
            mem_total_bytes: 0,
            boot_time_ms: 0,
            gpu_dvfs_mhz: Vec::new(),
            boot_mounts: Vec::new(),
            kernel: None,
        },
    }
}
