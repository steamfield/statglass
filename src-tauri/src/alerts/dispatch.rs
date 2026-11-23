//! Sends alerts to destinations: the production send function behind
//! [`super::AlertsService::on_alert`], which delivers each message on a blocking worker
//! and records the outcome, and the "Send test" message. The delivery itself is
//! `statglass_notify::deliver`.

use statglass_notify::Message;
use statglass_schema::{DeliveryOutcome, Destination};
use tauri::AppHandle;

use crate::error::CommandError;

/// The send function the host watcher passes to [`super::AlertsService::on_alert`]:
/// each call delivers the message on `tauri::async_runtime::spawn_blocking` with
/// `statglass_notify::deliver`, records the outcome under the service's lock with the
/// time it finished, then emits `alert-destinations-changed` with the new view outside
/// the lock. A failure is logged with the destination id and the outcome, never its URL,
/// topic or token.
pub fn background_sender(app: &AppHandle) -> impl Fn(Destination, Message) + use<> {
    let _ = app;
    |_destination, _message| {}
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
    let _ = (destination, host_name, now_ms, deliver);
    Err(super::not_implemented())
}
