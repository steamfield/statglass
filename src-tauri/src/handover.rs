mod bundle;
#[cfg(test)]
mod tests;
mod worker;

use std::{
    path::Path,
    sync::{Arc, OnceLock},
};

use serde::Serialize;
use statglass_engine::wall_ms;
use statglass_ipc::mobile::HandoverReasonInfo;
use statglass_remote::{
    DeviceTag, HandoverSource, RemoteCommand,
    intents::{IntentError, IntentLog, IntentOp, PendingIntent},
    ssh_config::HandoverInput,
};
use statglass_schema::{HostId, JsSafeInt};
use tauri::{AppHandle, Manager, State};
use tokio::sync::{mpsc, oneshot, watch};

use crate::error::CommandError;
use crate::pairing::PairingState;
use crate::state::AppState;
use worker::Apply;

#[derive(Clone, Default)]
pub struct HandoverState {
    controller: OnceLock<Arc<Controller>>,
}

struct Controller {
    from: HostId,
    log: Result<Box<dyn IntentStore>, IntentError>,
    hosts: Box<dyn Fn() -> Vec<RemoteHost> + Send + Sync>,
    apply: mpsc::UnboundedSender<Apply>,
}

pub(crate) struct RemoteHost {
    pub input: HandoverInput,
    pub enabled: bool,
    pub aliases: Result<Vec<String>, String>,
    pub command: RemoteCommand,
}

impl HandoverState {
    pub(crate) fn start(&self, app: &AppHandle, dir: &Path, stop: watch::Receiver<bool>) {
        let (apply, requests) = mpsc::unbounded_channel();
        let from = app.state::<AppState>().local;
        let app = app.clone();
        let log = IntentLog::open(dir.join("device-intents.jsonl"))
            .map(|log| Box::new(log) as Box<dyn IntentStore>);
        if let Err(error) = &log {
            tracing::warn!(%error, "opening the device intent log");
        }
        let controller = Arc::new(Controller {
            from,
            log,
            hosts: Box::new(move || app.state::<AppState>().remotes.handover_hosts()),
            apply,
        });
        if self.controller.set(controller.clone()).is_ok() {
            tauri::async_runtime::spawn(worker::run(controller, requests, stop));
        }
    }

    pub(crate) fn source(&self) -> Option<Arc<dyn HandoverSource>> {
        self.controller
            .get()
            .map(|controller| Arc::clone(controller) as _)
    }

    pub(crate) fn connected(&self, host: HostId) {
        if let Some(controller) = self.controller.get() {
            let _ = controller.apply.send(Apply::Host(host));
        }
    }

    pub(crate) fn record_revocations(&self, device: DeviceTag) -> Result<(), CommandError> {
        if let Some(controller) = self.controller.get() {
            controller.revoke(device).map_err(|error| match error {
                CommandError::Handover { message } => handover_error(format!(
                    "Access is revoked on this Mac. Couldn’t queue removal on other hosts. {message}"
                )),
                error => error,
            })?;
        }
        Ok(())
    }

    fn controller(&self) -> Result<Arc<Controller>, CommandError> {
        self.controller
            .get()
            .cloned()
            .ok_or_else(|| handover_error("iPhone handover has not started."))
    }
}

impl Controller {
    fn log(&self) -> Result<&dyn IntentStore, CommandError> {
        self.log.as_deref().map_err(handover_error)
    }

    async fn read_pending(self: &Arc<Self>) -> Result<Vec<PendingIntent>, CommandError> {
        let controller = self.clone();
        tokio::task::spawn_blocking(move || controller.log()?.pending().map_err(handover_error))
            .await
            .map_err(handover_error)?
    }

    fn revoke(&self, device: DeviceTag) -> Result<(), CommandError> {
        let log = self.log()?;
        let hosts = log.installed_hosts(&device).map_err(handover_error)?;
        if hosts.is_empty() {
            return Ok(());
        }
        let result = hosts
            .into_iter()
            .try_for_each(|host| self.record(host, device, IntentOp::Revoke));
        self.wake();
        result
    }

    fn record(&self, host: HostId, device: DeviceTag, op: IntentOp) -> Result<(), CommandError> {
        self.log()?
            .record(host, device, op, wall_ms())
            .map_err(handover_error)?;
        Ok(())
    }

    fn wake(&self) {
        let _ = self.apply.send(Apply::Pending);
    }

    fn pending_info(&self) -> Result<Vec<DeviceIntentInfo>, CommandError> {
        let pending = self.log()?.pending().map_err(handover_error)?;
        let hosts = (self.hosts)();
        Ok(pending
            .into_iter()
            .map(|intent| {
                let host_name = hosts
                    .iter()
                    .find(|host| host.input.host_id == intent.host)
                    .map_or_else(|| intent.host.to_string(), |host| host.input.name.clone());
                DeviceIntentInfo::new(intent, host_name)
            })
            .collect())
    }
}

trait IntentStore: Send + Sync {
    fn record(
        &self,
        host: HostId,
        device: DeviceTag,
        op: IntentOp,
        now_ms: i64,
    ) -> Result<u64, IntentError>;
    fn pending(&self) -> Result<Vec<PendingIntent>, IntentError>;
    fn installed_hosts(&self, device: &DeviceTag) -> Result<Vec<HostId>, IntentError>;
    fn finish(&self, seq: u64, result: Result<(), String>, now_ms: i64) -> Result<(), IntentError>;
}

impl IntentStore for IntentLog {
    fn record(
        &self,
        host: HostId,
        device: DeviceTag,
        op: IntentOp,
        now_ms: i64,
    ) -> Result<u64, IntentError> {
        self.record(host, device, op, now_ms)
    }

    fn pending(&self) -> Result<Vec<PendingIntent>, IntentError> {
        self.pending()
    }

    fn installed_hosts(&self, device: &DeviceTag) -> Result<Vec<HostId>, IntentError> {
        self.installed_hosts(device)
    }

    fn finish(&self, seq: u64, result: Result<(), String>, now_ms: i64) -> Result<(), IntentError> {
        match result {
            Ok(()) => self.mark_applied(seq, now_ms),
            Err(reason) => self.mark_failed(seq, &reason, now_ms),
        }
    }
}

fn handover_error(error: impl std::fmt::Display) -> CommandError {
    CommandError::Handover {
        message: error.to_string(),
    }
}

#[derive(Clone, Debug, Serialize, specta::Type)]
pub struct HandoverOffer {
    pub text: String,
    pub qr_svg: String,
    pub hosts: Vec<String>,
    pub unavailable: Vec<HandoverUnavailableInfo>,
    #[specta(type = JsSafeInt)]
    pub issued_ms: i64,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
pub struct HandoverUnavailableInfo {
    pub id: HostId,
    pub name: String,
    pub reason: HandoverReasonInfo,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
pub struct DeviceIntentInfo {
    pub host: HostId,
    pub host_name: String,
    pub device: String,
    pub device_name: String,
    pub op: String,
    pub state: String,
    pub reason: Option<String>,
    pub attempts: u32,
}

impl DeviceIntentInfo {
    fn new(intent: PendingIntent, host_name: String) -> Self {
        let (op, device_name) = match intent.install {
            Some((_, name)) if !name.trim().is_empty() => ("install", name),
            Some(_) => ("install", format!("iPhone {}", intent.device)),
            None => ("revoke", format!("iPhone {}", intent.device)),
        };
        Self {
            host: intent.host,
            host_name,
            device: intent.device.to_string(),
            device_name,
            op: op.into(),
            state: if intent.last_error.is_some() {
                "failed"
            } else {
                "pending"
            }
            .into(),
            reason: intent.last_error,
            attempts: intent.attempts,
        }
    }
}

/// Builds a phone update and queues keys for any newly offered host.
///
/// # Errors
///
/// Returns a command error if the QR or the new installs cannot be prepared.
#[tauri::command]
#[specta::specta]
pub async fn handover_bundle_start(
    state: State<'_, HandoverState>,
    pairing: State<'_, PairingState>,
) -> Result<HandoverOffer, CommandError> {
    let controller = state.controller()?;
    let prepare = controller.clone();
    let offer = tauri::async_runtime::spawn_blocking(move || prepare.prepare_offer())
        .await
        .map_err(handover_error)??;
    pairing
        .with_device_keys(move |keys| controller.finish_offer(offer, keys))
        .await
}

/// # Errors
///
/// Returns a handover error if the intent log cannot be read.
#[tauri::command]
#[specta::specta]
pub async fn device_intents(
    state: State<'_, HandoverState>,
) -> Result<Vec<DeviceIntentInfo>, CommandError> {
    let controller = state.controller()?;
    tauri::async_runtime::spawn_blocking(move || controller.pending_info())
        .await
        .map_err(handover_error)?
}

/// Retries the current pending intents and waits for their outcomes to be recorded.
///
/// # Errors
///
/// Returns a handover error if the worker or intent log is unavailable.
#[tauri::command]
#[specta::specta]
pub async fn retry_device_intents(state: State<'_, HandoverState>) -> Result<(), CommandError> {
    let (done, result) = oneshot::channel();
    state
        .controller()?
        .apply
        .send(Apply::Retry(done))
        .map_err(|_| handover_error("The device intent worker has stopped."))?;
    result
        .await
        .map_err(|_| handover_error("The device intent worker has stopped."))?
}
