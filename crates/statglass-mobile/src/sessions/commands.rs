use serde::Serialize;
use serde_json::Value;
use statglass_engine::Source;
use statglass_ipc::error::CommandError;
use statglass_ipc::history;
use statglass_ipc::mobile::MobileCall;
use statglass_schema::HostId;
use std::sync::Arc;

use super::{host::HostEntry, internal, registry::Registry};

impl Registry {
    pub(super) async fn call(self: &Arc<Self>, call: MobileCall) -> Result<Value, CommandError> {
        match call {
            MobileCall::ListHosts => value(self.records()?),
            MobileCall::ListRemoteHosts => {
                let entries = self.entries()?;
                blocking(move || value(entries.iter().map(|e| e.remote_host()).collect::<Vec<_>>()))
                    .await
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
            MobileCall::SetHostsRecentInterest { on } => {
                self.set_recent_interest(on)?;
                Ok(Value::Null)
            }
            MobileCall::SubscribeLive(request) => {
                let entry = self.entry(request.host)?;
                value(self.live.subscribe(entry, request, self.events.clone())?)
            }
            MobileCall::UnsubscribeLive { stream } => {
                self.live.unsubscribe(stream);
                Ok(Value::Null)
            }
            MobileCall::QueryHistory(request) => {
                let entry = self.entry(request.host)?;
                blocking(move || entry.query_history(&request)).await
            }
            MobileCall::QueryEvents {
                host,
                from_ms,
                to_ms,
            } => {
                let entry = self.entry(host)?;
                blocking(move || entry.query_events(host, from_ms, to_ms)).await
            }
            MobileCall::BuildInfo
            | MobileCall::SetHosts { .. }
            | MobileCall::SetDataPolicy(_)
            | MobileCall::AuthorizedKeyLine { .. } => {
                Err(internal("core call reached the session registry"))
            }
        }
    }
}

impl HostEntry {
    pub(super) fn query_history(
        &self,
        request: &history::HistoryRequest,
    ) -> Result<Value, CommandError> {
        let from = request.from_ms;
        self.with_history(|store| {
            value(history::query_history(
                store,
                request,
                self.policy.auto_choice(),
                || self.mirror.recent_rows(from, request.to_ms),
                |key, bucket| self.hub.history_hold_ms(key, bucket, from),
            )?)
        })
    }

    pub(super) fn query_events(
        &self,
        host: HostId,
        from_ms: i64,
        to_ms: i64,
    ) -> Result<Value, CommandError> {
        self.with_history(|store| value(history::query_events(store, host, from_ms, to_ms)?))
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
