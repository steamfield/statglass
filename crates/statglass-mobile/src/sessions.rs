//! The phone's remote hosts, mirrors and live streams.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use statglass_ipc::error::CommandError;
use statglass_ipc::mobile::{MobileCall, MobileConfig, MobileHost};
use statglass_session::network::LocalNetwork;
use statglass_session::{RemoteSource, SyncPolicy};
use statglass_ssh::{RusshDialer, Signer};
use tokio::runtime::Handle;

use crate::control::SessionControl;
use crate::ffi::CoreEvents;

mod commands;
mod endpoint;
mod host;
mod live;
mod phone_id;
mod registry;
#[cfg(test)]
mod tests;

use registry::Registry;

/// Every host the core runs a session for.
pub(crate) struct Sessions {
    registry: Arc<Registry>,
}

impl Sessions {
    pub(crate) fn new(events: Arc<dyn CoreEvents>) -> Self {
        Self {
            registry: Arc::new(Registry::new(events)),
        }
    }

    /// Opens mirrors under `data_dir`, loads or creates the phone id and starts
    /// a source per host on the core runtime.
    pub(crate) fn start(
        &self,
        runtime: Handle,
        data_dir: PathBuf,
        config: MobileConfig,
        signer: Arc<dyn Signer>,
        sync: SyncPolicy,
    ) -> Result<(), CommandError> {
        self.registry.start(
            runtime,
            data_dir,
            config.hosts,
            Arc::new(RusshDialer::new(signer)),
            sync,
        )
    }

    /// Replaces the configured hosts and recomputes their mirror budgets.
    pub(crate) fn set_hosts(
        &self,
        hosts: Vec<MobileHost>,
        sync: SyncPolicy,
    ) -> Result<(), CommandError> {
        self.registry.set_hosts(hosts, sync)
    }

    /// Answers the host, live and history calls delegated by the core.
    pub(crate) async fn call(&self, call: MobileCall) -> Result<Value, CommandError> {
        self.registry.call(call).await
    }
}

impl SessionControl for Sessions {
    fn sources(&self) -> Vec<Arc<RemoteSource>> {
        self.registry.sources()
    }

    fn set_sync_policy(&self, policy: SyncPolicy) {
        self.registry.set_sync_policy(policy);
    }

    fn network_changed(&self, net: LocalNetwork) {
        self.registry.network_changed(net);
    }
}

fn invalid(message: impl Into<String>) -> CommandError {
    CommandError::InvalidArgument {
        message: message.into(),
    }
}

fn internal(message: impl Into<String>) -> CommandError {
    CommandError::Internal {
        message: message.into(),
    }
}

fn callback<T>(name: &str, invoke: impl FnOnce() -> T) -> Option<T> {
    match catch_unwind(AssertUnwindSafe(invoke)) {
        Ok(result) => Some(result),
        Err(payload) => {
            let error = crate::envelope::panicked(payload.as_ref());
            tracing::error!(%error, callback = name, "mobile event callback");
            None
        }
    }
}
