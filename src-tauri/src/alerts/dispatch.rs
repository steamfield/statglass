//! Sends alerts to destinations: one delivery with its failure log and its record
//! ([`AlertsService::deliver_to`]), the production send function behind
//! [`AlertsService::on_alert`] that runs it on a blocking worker, and the "Send test"
//! message. The delivery itself is `statglass_notify::deliver`.

use statglass_notify::{DeliverOptions, Message, deliver};
use statglass_schema::{DeliveryOutcome, DeliveryRecord, Destination};
use tauri::{AppHandle, Manager};

use super::commands::emit_changed;
use super::{AlertDestinationsView, AlertsService};
use crate::error::CommandError;
use crate::state::AppState;

/// The [`Message::kind`] of a test message; no alert cause has this tag.
const TEST_KIND: &str = "test";

/// The send function the host watcher passes to [`AlertsService::on_alert`]: each call
/// runs [`AlertsService::deliver_to`] with `statglass_notify::deliver` on
/// `tauri::async_runtime::spawn_blocking`, then emits `alert-destinations-changed` with
/// the view it returns, outside the service's locks.
pub fn background_sender(app: &AppHandle) -> impl Fn(Destination, Message) + use<> {
    let app = app.clone();
    move |destination, message| {
        let app = app.clone();
        // Delivery can take about 40 s with retries, so it never runs on the caller's
        // thread (the host watcher).
        tauri::async_runtime::spawn_blocking(move || {
            let Some(state) = app.try_state::<AppState>() else {
                tracing::warn!(
                    destination = %destination.id,
                    "the app state is gone; alert not delivered"
                );
                return;
            };
            let recorded = state.alerts.deliver_to(
                &destination,
                &message,
                |destination, message| deliver(destination, message, &DeliverOptions::default()),
                statglass_engine::wall_ms,
            );
            if let Some(view) = recorded {
                emit_changed(&app, view);
            }
        });
    }
}

impl AlertsService {
    /// Delivers `message` to `destination` through `deliver`, logs a failure, and records
    /// the outcome at the time `now` gives once the delivery has finished. Returns the
    /// view to emit, or `None` when the outcome was dropped (see
    /// [`AlertsService::record`]). Blocks for as long as `deliver` does, holding no lock;
    /// only the record is made under `view`.
    pub fn deliver_to(
        &self,
        destination: &Destination,
        message: &Message,
        deliver: impl FnOnce(&Destination, &Message) -> DeliveryOutcome,
        now: impl Fn() -> i64,
    ) -> Option<AlertDestinationsView> {
        let outcome = deliver(destination, message);
        if let DeliveryOutcome::Failed { .. } = &outcome {
            // The id and the outcome only: the outcome's detail never names the URL or a
            // token, and the destination itself is never logged.
            tracing::warn!(destination = %destination.id, ?outcome, "alert delivery failed");
        }
        let record = DeliveryRecord {
            at_ms: now(),
            outcome,
        };
        self.record(destination, record)
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
