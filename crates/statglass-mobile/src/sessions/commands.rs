use serde::Serialize;
use serde_json::Value;
use statglass_engine::Source;
use statglass_ipc::error::CommandError;
use statglass_ipc::mobile::MobileCall;
use std::sync::Arc;

use super::{internal, registry::Registry};

impl Registry {
    pub(super) async fn call(self: &Arc<Self>, call: MobileCall) -> Result<Value, CommandError> {
        match call {
            MobileCall::ListHosts => value(self.records()?),
            MobileCall::ListRemoteHosts => {
                let registry = self.clone();
                blocking(move || value(registry.remote_hosts()?)).await
            }
            MobileCall::GetHost { host } => value(self.entry(host)?.source.host()),
            MobileCall::GetCapabilities { host } => value(self.entry(host)?.source.capabilities()),
            MobileCall::HostVitals { host } => value(self.entry(host)?.vitals()),
            MobileCall::RetryRemoteHost { host } => {
                let registry = self.clone();
                blocking(move || {
                    registry.retry(host)?;
                    Ok(Value::Null)
                })
                .await
            }
            MobileCall::SubscribeLive(request) => {
                let entry = self.entry(request.host)?;
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
            | MobileCall::AuthorizedKeyLine { .. } => {
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
        .map_err(|error| internal(format!("mobile history task failed: {error}")))?
}
