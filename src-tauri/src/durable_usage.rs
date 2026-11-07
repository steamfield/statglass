//! Source-owned durable attribution. Remote answers never come from the metric mirror.
use crate::commands::blocking;
use crate::error::CommandError;
use crate::state::{AppState, Route};
use statglass_schema::durable_usage::{
    HistoricalUsageReply, HistoricalUsageRequest, UsageProcessReply, UsageProcessRequest,
};
use tauri::{AppHandle, Manager};

#[tauri::command]
#[specta::specta]
pub async fn query_historical_usage(
    app: AppHandle,
    request: HistoricalUsageRequest,
) -> Result<HistoricalUsageReply, CommandError> {
    request.validate()?;
    let route = app.state::<AppState>().route(request.host)?;
    if let Route::Remote(source) = route {
        return Ok(source.historical_usage(request).await?);
    }
    blocking(app, move |state| {
        let entry = state.local_host(request.host)?;
        Ok(state.history.store().historical_usage(&request, || {
            entry.recent_usage_apps(request.from_ms, request.to_ms)
        })?)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn query_usage_processes(
    app: AppHandle,
    request: UsageProcessRequest,
) -> Result<UsageProcessReply, CommandError> {
    request.validate()?;
    let route = app.state::<AppState>().route(request.host)?;
    if let Route::Remote(source) = route {
        return Ok(source.usage_processes(request).await?);
    }
    blocking(app, move |state| {
        let entry = state.local_host(request.host)?;
        Ok(state.history.store().usage_processes(&request, || {
            entry.recent_usage_processes(request.from_ms, request.to_ms, &request.app_name)
        })?)
    })
    .await
}
