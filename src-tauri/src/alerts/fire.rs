//! What happens when an alert fires, in one place for every source of alerts: the
//! engine's rules (already in the store when they reach the host watcher) and the
//! shell's host-offline watch (recorded here) and Linux agent mirrors (already
//! stored). A fired alert posts its notification,
//! goes to every enabled destination, and reaches every window as `event-recorded`
//! (plan/rfc-alerts.md 4.7).
//!
//! The steps go through [`AlertSinks`], so the order and the failure handling are
//! tested without Tauri; [`ShellSinks`] is the production set.

use anyhow::Context;
use statglass_notify::{AlertText, Message, alert_text, catch_up_text, remote_alert_text};
use statglass_schema::settings::UnitSettings;
use statglass_schema::{Destination, Event, HostId, HostRecord};
use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime, Wry};
use tauri_specta::Event as _;

use super::remote_delivery::LateAlert;
use super::{AlertsService, background_sender};
use crate::history::History;
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

/// Posts one notice and sends one copy to each enabled destination for a batch
/// of late alerts. The newest alert's corrected time is the message's fired time.
pub(super) fn announce_catch_up<'a>(
    alerts: &AlertsService,
    host_name: &str,
    units: &UnitSettings,
    events: impl IntoIterator<Item = &'a Event>,
    fired_at_ms: i64,
    notify: impl FnOnce(AlertText),
    send: impl Fn(Destination, Message),
) {
    let Some(text) = catch_up_text(host_name, events, units) else {
        return;
    };
    let message = Message::from_alert_text(text.clone(), host_name, fired_at_ms);
    notify(text);
    alerts.send_message(&message, send);
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

/// The production sinks for alerts from `host`, with values in `units`.
#[derive(Clone)]
pub(crate) struct AlertOutputs {
    pub(crate) post: Arc<dyn Fn(AlertText) + Send + Sync>,
    pub(crate) send: Arc<dyn Fn(Destination, Message) + Send + Sync>,
}

impl AlertOutputs {
    pub(crate) fn shell(app: &AppHandle) -> Self {
        let handle = app.clone();
        Self {
            post: Arc::new(move |text| notify::alert(&handle, text)),
            send: Arc::new(background_sender(app)),
        }
    }
}

pub struct ShellSinks<'a, R: Runtime = Wry> {
    pub(super) app: &'a AppHandle<R>,
    pub(super) alerts: &'a AlertsService,
    pub(super) history: &'a History,
    pub(super) host: HostRecord,
    pub(super) units: UnitSettings,
    pub(super) outputs: AlertOutputs,
    pub(super) offset_ms: i64,
}

impl<'a> ShellSinks<'a> {
    /// Sinks for `host`'s alerts, reading the units from the current settings.
    pub fn new(app: &'a AppHandle, state: &'a AppState, host: HostRecord) -> Self {
        let units = state.settings.settings().units;
        Self {
            app,
            alerts: &state.alerts,
            history: &state.history,
            host,
            units,
            outputs: AlertOutputs::shell(app),
            offset_ms: 0,
        }
    }
}

impl<R: Runtime> ShellSinks<'_, R> {
    pub(super) fn catch_up(&self, events: &[LateAlert]) {
        if let Some(newest) = events.iter().map(|alert| alert.local_ms).max() {
            announce_catch_up(
                self.alerts,
                &self.host.display_name,
                &self.units,
                events.iter().map(|alert| &alert.event),
                newest,
                self.outputs.post.as_ref(),
                self.outputs.send.as_ref(),
            );
        }
    }

    fn send(&self, text: AlertText, fired_at_ms: i64) {
        let message = Message::from_alert_text(text, &self.host.display_name, fired_at_ms);
        self.alerts
            .send_message(&message, self.outputs.send.as_ref());
    }
}

impl<R: Runtime> AlertSinks for ShellSinks<'_, R> {
    fn record(&self, event: &Event) -> anyhow::Result<()> {
        let writer = self
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
        let text = if self.host.is_local {
            alert_text(event, &self.units)
        } else {
            remote_alert_text(&self.host.display_name, event, &self.units)
        };
        if let Some(text) = text {
            (self.outputs.post)(text);
        }
    }

    fn deliver(&self, event: &Event) {
        if self.host.is_local {
            self.alerts.on_alert(
                event,
                &self.host.display_name,
                &self.units,
                self.outputs.send.as_ref(),
            );
        } else if let Some(text) = remote_alert_text(&self.host.display_name, event, &self.units) {
            self.send(text, event.ts_ms.saturating_sub(self.offset_ms));
        }
    }

    fn publish(&self, event: &Event) {
        publish(self.app, self.host.id, event);
    }
}

/// An event from `host`'s bus, as the host watcher receives it: the local host's
/// events are announced ([`announce`]). Remote alerts are delivered after the mirror
/// commits them, so the remote bus only publishes to the windows.
pub fn on_bus_event(app: &AppHandle, host: HostRecord, event: &Event) {
    match app.try_state::<AppState>() {
        Some(state) if host.is_local => announce(&ShellSinks::new(app, &state, host), event),
        _ => publish(app, host.id, event),
    }
}

/// Emits `event-recorded` for `host`.
fn publish<R: Runtime>(app: &AppHandle<R>, host: HostId, event: &Event) {
    let recorded = EventRecorded {
        host,
        event: event.clone(),
    };
    if let Err(e) = recorded.emit(app) {
        tracing::warn!("emitting event-recorded: {e}");
    }
}
