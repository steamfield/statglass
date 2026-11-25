//! The phone's hosts and their sessions: one `RemoteSource` over the russh dialer and a
//! phone-policy `Mirror` per host, the live streams the app opens on them, and the
//! commands that read them (phase 4 lane a).

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use statglass_ipc::error::CommandError;
use statglass_ipc::mobile::{MobileCall, MobileConfig, MobileHost};
use statglass_session::network::LocalNetwork;
use statglass_session::{RemoteSource, SyncPolicy};
use tokio::runtime::Handle;

use crate::control::SessionControl;
use crate::ffi::CoreEvents;

/// Every host the core runs a session for.
pub(crate) struct Sessions {
    #[expect(
        dead_code,
        reason = "phase 4 lane a pushes live messages and events through it"
    )]
    events: Arc<dyn CoreEvents>,
}

impl Sessions {
    pub(crate) fn new(events: Arc<dyn CoreEvents>) -> Self {
        Self { events }
    }

    /// Opens the mirror store under `data_dir`, loads or creates the phone's own host
    /// id there, and starts a source per host on `runtime`, signing with `signer`.
    ///
    /// # Errors
    ///
    /// The store or the phone id could not be opened, or a host is invalid.
    pub(crate) fn start(
        &self,
        runtime: Handle,
        data_dir: PathBuf,
        config: MobileConfig,
        signer: Arc<dyn statglass_ssh::Signer>,
        sync: SyncPolicy,
    ) -> Result<(), CommandError> {
        let _ = (runtime, data_dir, config, signer, sync);
        Err(not_implemented())
    }

    /// Replaces the hosts: stops sources for hosts no longer listed, starts new ones
    /// with `sync`, and resizes every mirror's budget to its share of the total.
    ///
    /// # Errors
    ///
    /// The core has not started, or a host is invalid.
    pub(crate) fn set_hosts(
        &self,
        hosts: Vec<MobileHost>,
        sync: SyncPolicy,
    ) -> Result<(), CommandError> {
        let _ = (crate::policy::host_budget_mb(hosts.len()), sync);
        Err(not_implemented())
    }

    /// Answers a host, live or history call. `SetHosts`, `SetDataPolicy`,
    /// `AuthorizedKeyLine` and `BuildInfo` are answered by the core itself.
    ///
    /// # Errors
    ///
    /// The call's typed failure.
    pub(crate) async fn call(&self, call: MobileCall) -> Result<Value, CommandError> {
        let _ = call;
        Err(not_implemented())
    }
}

impl SessionControl for Sessions {
    fn sources(&self) -> Vec<Arc<RemoteSource>> {
        Vec::new()
    }

    fn set_sync_policy(&self, policy: SyncPolicy) {
        let _ = policy;
    }

    fn network_changed(&self, net: LocalNetwork) {
        let _ = net;
    }
}

fn not_implemented() -> CommandError {
    CommandError::Internal {
        message: "statglass-mobile sessions: not implemented".into(),
    }
}
