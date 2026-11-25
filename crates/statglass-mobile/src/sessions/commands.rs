use serde::Serialize;
use serde_json::Value;
use statglass_engine::Source;
use statglass_ipc::error::CommandError;
use statglass_ipc::mobile::MobileCall;
use std::sync::Arc;

use super::{Sessions, demand, internal, registry::Registry};

impl Sessions {
    /// Answers the host, live and history calls delegated by the core.
    pub(crate) async fn call(&self, call: MobileCall) -> Result<Value, CommandError> {
        match call {
            MobileCall::RemoveHost { host } => {
                let sessions = self.clone();
                blocking(move || sessions.remove_host(host).map(|()| Value::Null)).await
            }
            MobileCall::SetDemand { demand } => demand::set_demand(self, demand),
            other => self.registry.call(other).await,
        }
    }
}

impl Registry {
    pub(super) async fn call(self: &Arc<Self>, call: MobileCall) -> Result<Value, CommandError> {
        match call {
            MobileCall::ListHosts => value(self.records()?),
            MobileCall::ListRemoteHosts => {
                let registry = self.clone();
                blocking(move || value(registry.remote_hosts()?)).await
            }
            MobileCall::GetHost { host } => value(self.entry(host)?.record()),
            MobileCall::GetCapabilities { host } => value(
                self.entry(host)?
                    .ready()?
                    .map_or_else(Default::default, |entry| entry.source.capabilities()),
            ),
            MobileCall::HostVitals { host } => value(
                self.entry(host)?
                    .ready()?
                    .map_or_else(Default::default, |entry| entry.vitals()),
            ),
            MobileCall::RetryRemoteHost { host } => {
                let registry = self.clone();
                blocking(move || {
                    registry.retry(host)?;
                    Ok(Value::Null)
                })
                .await
            }
            MobileCall::SubscribeLive(request) => {
                let entry = self.entry(request.host)?.running()?;
                value(self.live.subscribe(entry, request, self.events.clone())?)
            }
            MobileCall::UnsubscribeLive { stream } => {
                self.live.unsubscribe(stream);
                Ok(Value::Null)
            }
            MobileCall::HostHistory(request) => value(self.host_history(request).await?),
            MobileCall::NetworkAddresses { host } => value(self.network_addresses(host).await?),
            MobileCall::SetProcessInterest { .. } => Ok(Value::Null),
            MobileCall::BuildInfo
            | MobileCall::SetHosts { .. }
            | MobileCall::SetDataPolicy(_)
            | MobileCall::AuthorizedKeyLine { .. }
            | MobileCall::PreviewPairing { .. }
            | MobileCall::Pair { .. }
            | MobileCall::PairingState
            | MobileCall::RemoveHost { .. }
            | MobileCall::SetDemand { .. } => {
                Err(internal("core call reached the session registry"))
            }
        }
    }
}

fn value(data: impl Serialize) -> Result<Value, CommandError> {
    serde_json::to_value(data)
        .map_err(|error| internal(format!("serializing mobile result: {error}")))
}

async fn blocking(
    run: impl FnOnce() -> Result<Value, CommandError> + Send + 'static,
) -> Result<Value, CommandError> {
    tokio::task::spawn_blocking(run)
        .await
        .map_err(|error| internal(format!("mobile registry task failed: {error}")))?
}
