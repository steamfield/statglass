//! The phone's remote hosts and live streams.

use std::collections::HashSet;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::Arc;

use statglass_ipc::error::CommandError;
use statglass_ipc::mobile::{MobileConfig, MobileHost, PairedHost, PairingState};
use statglass_proto::handover::HostBundle;
use statglass_schema::HostId;
use statglass_session::network::LocalNetwork;
use statglass_session::{Dialer, RemoteSource};
use tokio::runtime::Handle;

use crate::control::SessionControl;
use crate::ffi::{CoreEvents, NativeSigner, NativeSignerError};
use crate::handover::{self, PendingHandover};
use crate::lifecycle::Lifecycle;

mod addresses;
mod commands;
mod demand;
mod endpoint;
mod history;
mod host;
mod live;
mod phone_id;
mod processes;
mod registry;
#[cfg(test)]
pub(crate) mod tests;

use registry::Registry;

/// Every host the core runs a session for.
#[derive(Clone)]
pub(crate) struct Sessions {
    registry: Arc<Registry>,
}

impl Sessions {
    pub(crate) fn new(events: Arc<dyn CoreEvents>, signer: Option<Arc<dyn NativeSigner>>) -> Self {
        Self {
            registry: Arc::new(Registry::new(events, signer)),
        }
    }

    pub(crate) fn is_started(&self) -> bool {
        self.registry.is_started()
    }

    pub(crate) fn lifecycle(&self) -> &Arc<Lifecycle> {
        &self.registry.lifecycle
    }

    /// Loads or creates the phone id under `data_dir` and starts a source per host.
    pub(crate) fn start(
        &self,
        runtime: Handle,
        data_dir: PathBuf,
        config: MobileConfig,
        dialer: Arc<dyn Dialer>,
    ) -> Result<(), CommandError> {
        self.registry.start(runtime, data_dir, config.hosts, dialer)
    }

    /// Replaces the configured hosts.
    pub(crate) fn set_hosts(&self, hosts: Vec<MobileHost>) -> Result<(), CommandError> {
        self.registry.update_hosts(None, |_, desired, _, _| {
            *desired = hosts;
            Ok(())
        })
    }

    pub(crate) fn remove_host(&self, host: HostId) -> Result<(), CommandError> {
        self.registry.update_hosts(None, |_, hosts, _, _| {
            let index = hosts
                .iter()
                .position(|entry| entry.id == host)
                .ok_or(CommandError::UnknownHost { host })?;
            hosts.remove(index);
            Ok(())
        })
    }

    pub(crate) fn phone_id(&self) -> Result<HostId, CommandError> {
        self.registry.phone_id()
    }

    pub(crate) fn add_paired_host(
        &self,
        mut host: MobileHost,
        device_key: &[u8],
        mut offered: Vec<statglass_ipc::mobile::OfferedHost>,
        unavailable: Vec<statglass_ipc::mobile::UnavailableHostInfo>,
    ) -> Result<PairedHost, CommandError> {
        self.registry
            .update_hosts(Some((host.id, device_key)), |_, hosts, store, handover| {
                offered.retain(|offer| hosts.iter().all(|current| current.id != offer.id));
                let existing = hosts.iter_mut().find(|entry| entry.id == host.id);
                if let Some(existing) = existing.as_ref() {
                    host.name.clone_from(&existing.name);
                }
                let paired = PairedHost {
                    id: host.id,
                    name: host.name.clone(),
                    offered,
                    unavailable,
                };
                store.controllers.remove(&host.id);
                *handover = (!paired.offered.is_empty()).then(|| PendingHandover::Pairing {
                    from: host.id,
                    offered: paired.offered.clone(),
                });
                match existing {
                    Some(existing) => *existing = host,
                    None => hosts.push(host),
                }
                Ok(paired)
            })
    }

    pub(crate) fn stage_bundle(
        &self,
        bundle: HostBundle,
    ) -> Result<statglass_ipc::mobile::BundleReconcile, CommandError> {
        self.registry
            .stage_handover(move |id, phone, hosts, store| {
                handover::validate_bundle(phone, store, &bundle)?;
                let preview = handover::preview(id, hosts, &store.controllers, &bundle);
                Ok((PendingHandover::Bundle { id, bundle }, preview))
            })
    }

    pub(crate) fn add_handover_hosts(
        &self,
        selected: Vec<statglass_ipc::mobile::OfferedHost>,
        preview_id: Option<u32>,
    ) -> Result<(), CommandError> {
        self.registry
            .update_hosts(None, |phone, hosts, store, handover| {
                handover::apply(phone, hosts, store, handover.take(), selected, preview_id)
            })
    }

    pub(crate) fn pairing_state(&self) -> PairingState {
        self.registry.pairing_state()
    }
}

impl SessionControl for Sessions {
    fn sources(&self) -> Vec<Arc<RemoteSource>> {
        self.registry.sources()
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

pub(crate) fn validate_hosts(hosts: &[MobileHost]) -> Result<(), CommandError> {
    let mut ids = HashSet::with_capacity(hosts.len());
    for host in hosts {
        if !ids.insert(host.id) {
            return Err(invalid(format!("duplicate host {}", host.id)));
        }
        if host.targets.is_empty() || host.user.is_empty() {
            return Err(invalid(format!(
                "host {} needs a user and at least one target",
                host.id
            )));
        }
    }
    Ok(())
}

fn current_device_key(signer: Option<&dyn NativeSigner>) -> Result<Option<Vec<u8>>, CommandError> {
    let Some(signer) = signer else {
        return Ok(None);
    };
    let key = callback("reading phone key", || signer.public_key())
        .ok_or_else(|| internal("reading the phone's SSH public key panicked"))?
        .map_err(|error| match error {
            NativeSignerError::Unavailable { .. } => CommandError::PhoneKeyUnavailable,
            error => internal(format!("reading the phone's SSH public key: {error}")),
        })?;
    match key.as_slice() {
        [4, coordinates @ ..] if coordinates.len() == 64 => Ok(Some(key)),
        [] => Err(CommandError::PhoneKeyUnavailable),
        _ => Err(internal(
            "the phone's SSH public key is not an uncompressed P-256 point",
        )),
    }
}

fn observed_device_key(signer: Option<&dyn NativeSigner>) -> Option<Vec<u8>> {
    current_device_key(signer)
        .inspect_err(|error| tracing::warn!(%error, "checking the phone's SSH public key for the host store"))
        .ok()
        .flatten()
}

fn callback<T>(name: &str, invoke: impl FnOnce() -> T) -> Option<T> {
    match catch_unwind(AssertUnwindSafe(invoke)) {
        Ok(result) => Some(result),
        Err(payload) => {
            crate::envelope::panicked(payload.as_ref(), name);
            None
        }
    }
}
