//! Sends alerts to destinations: the production send function behind
//! [`super::AlertsService::on_alert`], which delivers each message on a blocking worker
//! and records the outcome, and the "Send test" message. The delivery itself is
//! `statglass_notify::deliver`.

use statglass_notify::{DeliverOptions, Message, deliver};
use statglass_schema::{DeliveryOutcome, DeliveryRecord, Destination};
use tauri::{AppHandle, Manager};

use super::commands::emit_changed;
use crate::error::CommandError;
use crate::state::AppState;

/// The [`Message::kind`] of a test message; no alert cause has this tag.
const TEST_KIND: &str = "test";

/// The send function the host watcher passes to [`super::AlertsService::on_alert`]:
/// each call delivers the message on `tauri::async_runtime::spawn_blocking` with
/// `statglass_notify::deliver`, records the outcome under the service's lock with the
/// time it finished, then emits `alert-destinations-changed` with the new view outside
/// the lock. A failure is logged with the destination id and the outcome, never its URL,
/// topic or token.
pub fn background_sender(app: &AppHandle) -> impl Fn(Destination, Message) + use<> {
    let app = app.clone();
    move |destination, message| {
        let app = app.clone();
        // Delivery can take about 40 s with retries, so it never runs on the caller's
        // thread (the host watcher).
        tauri::async_runtime::spawn_blocking(move || {
            deliver_and_record(&app, &destination, &message);
        });
    }
}

/// Delivers one message, then records and announces the outcome. Blocking.
fn deliver_and_record(app: &AppHandle, destination: &Destination, message: &Message) {
    let outcome = deliver(destination, message, &DeliverOptions::default());
    if let DeliveryOutcome::Failed { .. } = &outcome {
        // `outcome` holds only the failure kind and a detail that never names the URL.
        tracing::warn!(destination = %destination.id, ?outcome, "alert delivery failed");
    }
    let record = DeliveryRecord {
        at_ms: statglass_engine::wall_ms(),
        outcome,
    };
    let Some(state) = app.try_state::<AppState>() else {
        tracing::warn!(
            destination = %destination.id,
            "alert delivery finished after the app state was gone; outcome not recorded"
        );
        return;
    };
    if let Some(view) = state.alerts.record(destination.id, record) {
        emit_changed(app, view);
    }
}

/// Sends "Test from StatGlass on `host_name`" to `destination` through `deliver` and
/// returns the outcome. The destination is not saved and nothing is recorded, so the
/// dialog can test a form before saving it. Blocking.
///
/// # Errors
///
/// [`CommandError::InvalidArgument`] with the validation message when `destination` is
/// invalid; nothing is sent.
pub fn send_test(
    destination: Destination,
    host_name: &str,
    now_ms: i64,
    deliver: impl FnOnce(&Destination, &Message) -> DeliveryOutcome,
) -> Result<DeliveryOutcome, CommandError> {
    destination.validate().map_err(super::invalid)?;
    Ok(deliver(&destination, &test_message(host_name, now_ms)))
}

/// The message "Send test" delivers.
fn test_message(host_name: &str, now_ms: i64) -> Message {
    Message {
        title: format!("Test from StatGlass on {host_name}"),
        body: format!("Alerts from {host_name} will arrive here."),
        host: host_name.to_owned(),
        rule: None,
        kind: TEST_KIND.to_owned(),
        fired_at_ms: now_ms,
    }
}
