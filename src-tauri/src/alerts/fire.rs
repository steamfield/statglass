//! What happens when an alert fires, in one place for every source of alerts: the
//! engine's rules (already in the store when they reach the host watcher) and the
//! shell's host-offline watch (recorded here). A fired alert posts its notification,
//! goes to every enabled destination, and reaches every window as `event-recorded`
//! (plan/rfc-alerts.md 4.7).
//!
//! The steps go through [`AlertSinks`], so the order and the failure handling are
//! tested without Tauri; [`ShellSinks`] is the production set.

use anyhow::Context;
use statglass_schema::settings::UnitSettings;
use statglass_schema::{Event, HostId, HostRecord};
use tauri::{AppHandle, Manager};
use tauri_specta::Event as _;

use super::background_sender;
use crate::ipc::EventRecorded;
use crate::notify;
use crate::state::AppState;

/// Where a fired alert goes.
pub trait AlertSinks {
    /// Queues `event` in the local host's store with a commit behind it.
    ///
    /// # Errors
    ///
    /// When history is unavailable or the writer refuses the event.
    fn record(&self, event: &Event) -> anyhow::Result<()>;
    /// Posts the macOS notification.
    fn notify(&self, event: &Event);
    /// Hands the alert to every enabled destination.
    fn deliver(&self, event: &Event);
    /// Emits `event-recorded`, so every window shows it.
    fn publish(&self, event: &Event);
}

/// An alert already in the store (the engine records its own): the notification, the
/// destinations, then the windows.
pub fn announce(sinks: &impl AlertSinks, event: &Event) {
    sinks.notify(event);
    sinks.deliver(event);
    sinks.publish(event);
}

/// An alert raised outside the engine: recorded in the local store, then announced. A
/// failed record is logged and the alert still goes out (RFC 6.5): the user gets it,
/// and only the Timeline lacks its pill.
pub fn record_and_announce(sinks: &impl AlertSinks, event: &Event) {
    if let Err(error) = sinks.record(event) {
        tracing::warn!(
            kind = event.detail.kind(),
            "recording an alert event: {error:#}"
        );
    }
    announce(sinks, event);
}

/// The production sinks for alerts of the local host `host`, with values in `units`.
pub struct ShellSinks<'a> {
    app: &'a AppHandle,
    state: &'a AppState,
    host: HostRecord,
    units: UnitSettings,
}

impl<'a> ShellSinks<'a> {
    /// Sinks for `host`'s alerts, reading the units from the current settings.
    pub fn new(app: &'a AppHandle, state: &'a AppState, host: HostRecord) -> Self {
        let units = state.settings.settings().units;
        Self {
            app,
            state,
            host,
            units,
        }
    }
}

impl AlertSinks for ShellSinks<'_> {
    fn record(&self, event: &Event) -> anyhow::Result<()> {
        let writer = self
            .state
            .history
            .writer()
            .context("opening the history writer")?;
        writer
            .record_event(self.host.id, event)
            .context("queueing the event")?;
        writer.commit_soon().context("queueing its commit")?;
        Ok(())
    }

    fn notify(&self, event: &Event) {
        notify::alert(self.app, event, &self.units);
    }

    fn deliver(&self, event: &Event) {
        let sender = background_sender(self.app);
        self.state
            .alerts
            .on_alert(event, &self.host.display_name, &self.units, sender);
    }

    fn publish(&self, event: &Event) {
        publish(self.app, self.host.id, event);
    }
}

/// An event from `host`'s bus, as the host watcher receives it: the local host's
/// events are announced ([`announce`]); a remote host's only reach the windows, since
/// remote alerts are not this Mac's to deliver.
pub fn on_bus_event(app: &AppHandle, host: HostRecord, event: &Event) {
    match app.try_state::<AppState>() {
        Some(state) if host.is_local => announce(&ShellSinks::new(app, &state, host), event),
        _ => publish(app, host.id, event),
    }
}

/// Emits `event-recorded` for `host`.
fn publish(app: &AppHandle, host: HostId, event: &Event) {
    let recorded = EventRecorded {
        host,
        event: event.clone(),
    };
    if let Err(e) = recorded.emit(app) {
        tracing::warn!("emitting event-recorded: {e}");
    }
}
