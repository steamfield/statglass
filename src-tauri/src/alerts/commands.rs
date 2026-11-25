//! The Tauri commands for alert destinations and the event that announces a change.
//! Thin: each one calls [`super::AlertsService`] or [`super::send_test`] off the main
//! thread and emits the view the service returns.

use serde::Serialize;
use statglass_notify::{DeliverOptions, deliver};
use statglass_schema::{DeliveryOutcome, Destination};
use tauri::{AppHandle, Manager, State};
use tauri_specta::Event;
use uuid::Uuid;

use super::AlertDestinationsView;
use crate::error::CommandError;
use crate::state::AppState;

pub use super::remote_rules::*;

/// Sent to every window when a destination is saved or deleted, or a delivery to one
/// finishes, so the Alerts page updates without a refetch.
#[derive(Clone, Debug, Serialize, specta::Type, Event)]
pub struct AlertDestinationsChanged {
    pub view: AlertDestinationsView,
}

/// Emits [`AlertDestinationsChanged`] with `view`; a failed emit is logged.
pub fn emit_changed(app: &AppHandle, view: AlertDestinationsView) {
    if let Err(e) = (AlertDestinationsChanged { view }).emit(app) {
        tracing::warn!("emitting alert-destinations-changed: {e}");
    }
}

/// Every destination with its last delivery, and why the file could not be read at
/// launch, if it could not.
#[tauri::command]
#[specta::specta]
pub fn alert_destinations_get(state: State<'_, AppState>) -> AlertDestinationsView {
    state.alerts.view()
}

/// Adds a destination, or replaces the one with its id.
///
/// # Errors
///
/// `invalid_argument` with the reason when it fails validation or would be one too
/// many; `settings_not_saved` when the file cannot be written.
#[tauri::command]
#[specta::specta]
pub async fn alert_destination_save(
    app: AppHandle,
    destination: Destination,
) -> Result<AlertDestinationsView, CommandError> {
    let view =
        crate::commands::blocking(app.clone(), move |state| state.alerts.save(destination)).await?;
    emit_changed(&app, view.clone());
    Ok(view)
}

/// Removes a destination.
///
/// # Errors
///
/// `invalid_argument` when no destination has `id`; `settings_not_saved` when the file
/// cannot be written.
#[tauri::command]
#[specta::specta]
pub async fn alert_destination_delete(
    app: AppHandle,
    id: Uuid,
) -> Result<AlertDestinationsView, CommandError> {
    let view = crate::commands::blocking(app.clone(), move |state| state.alerts.delete(id)).await?;
    emit_changed(&app, view.clone());
    Ok(view)
}

/// Sends a test message to `destination`, saved or not, and returns what came of it.
/// Takes up to the delivery's timeout and retries.
///
/// # Errors
///
/// `invalid_argument` with the reason when `destination` is invalid.
#[tauri::command]
#[specta::specta]
pub async fn alert_destination_test(
    app: AppHandle,
    destination: Destination,
) -> Result<DeliveryOutcome, CommandError> {
    let host_name = {
        let state = app.state::<AppState>();
        state.host(state.local)?.record().display_name
    };
    crate::commands::spawn_blocking(move || {
        super::send_test(
            destination,
            &host_name,
            statglass_engine::wall_ms(),
            |destination, message| deliver(destination, message, &DeliverOptions::default()),
        )
    })
    .await?
}
