//! Alert notifications (v1.2) through `tauri-plugin-notification`. The engine records
//! a fired alert as an `alert` event; the host watcher (state.rs) passes it here. What a
//! notification says comes from `statglass-notify`; this module only posts it.
//!
//! What the plugin does on macOS, read from its source (2.5.1) and observed (D-084):
//! it posts through `notify-rust` (`NSUserNotificationCenter`), under Terminal's bundle id
//! in `tauri dev` and under the app's identifier in a bundled build. It has no
//! permission step on desktop (`request_permission` resolves Granted without asking;
//! macOS asks on the first delivery) and drops click actions on desktop, so a click
//! cannot be routed to the Timeline through it.
//!
//! Because macOS asks on the first delivery, switching a rule on posts a confirmation
//! ([`alerts_on`]) right away: the permission prompt then appears while the user is in
//! Settings, not with the first real alert, which may be hours later.

use statglass_notify::{AlertText, alert_text, alerts_on_text};
use statglass_schema::settings::UnitSettings;
use statglass_schema::{AlertRule, Event};
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// Called when an alert rule is switched on. The plugin resolves at once on desktop; the
/// call stays so a plugin that gains a desktop permission step asks at the right moment.
pub fn request_permission(app: &AppHandle) {
    match app.notification().request_permission() {
        Ok(state) => tracing::info!(?state, "notification permission"),
        Err(e) => tracing::warn!("requesting notification permission: {e}"),
    }
}

/// Posts a one-off confirmation that `rules`, and the host-offline alert when
/// `host_offline` is true, were switched on, with values in `units`. On macOS the first
/// delivery is what shows the permission prompt, so this makes it appear now.
pub fn alerts_on(app: &AppHandle, rules: &[AlertRule], host_offline: bool, units: &UnitSettings) {
    let Some(text) = alerts_on_text(rules, host_offline, units) else {
        return;
    };
    post(app, text, "posting the alerts-on confirmation");
}

/// Posts the notification for an `alert` event, with values in `units`. Other events
/// post nothing.
pub fn alert(app: &AppHandle, event: &Event, units: &UnitSettings) {
    let Some(text) = alert_text(event, units) else {
        return;
    };
    post(app, text, "posting an alert notification");
}

fn post(app: &AppHandle, text: AlertText, what: &str) {
    let title = text.title.clone();
    let shown = app
        .notification()
        .builder()
        .title(text.title)
        .body(text.body)
        .show();
    if let Err(e) = shown {
        tracing::warn!(title = %title, error = ?e, "{what}");
    }
}
