//! The host-offline poll (plan/rfc-alerts.md 6.1, 6.6): every 30 seconds, while the
//! built-in host-offline rule is on and a remote host is saved, the saved hosts'
//! statuses go through [`host_watch::poll`] and every alert it returns is fired like
//! any other ([`fire::record_and_announce`]). With the rule off or no host saved the
//! watch is reset, so switching the rule back on starts every count again.

use std::time::Duration;

use statglass_schema::AlertRule;
use tauri::{AppHandle, Manager};

use super::fire::{self, ShellSinks};
use super::host_offline::HostOfflineWatch;
use super::host_watch;
use crate::state::AppState;

/// How often the saved hosts are observed.
pub const POLL_PERIOD: Duration = Duration::from_secs(30);
/// Observed unreachable time after which a host is offline, from the rule.
pub const OFFLINE_AFTER_MS: i64 = AlertRule::HOST_OFFLINE_AFTER_SECS as i64 * 1000;
/// Three poll periods: two observations further apart than this (this Mac slept, or
/// the task was starved) do not count the time between them.
pub const MAX_STEP_MS: i64 = 3 * 30_000;

/// Whether a poll observes the hosts: only while the rule is on and at least one
/// remote host is saved. Otherwise the watch is reset.
pub fn should_watch(rule_on: bool, saved_hosts: usize) -> bool {
    rule_on && saved_hosts > 0
}

/// Starts the poll on the async runtime; it runs for the life of the app. Never
/// blocks: reading statuses and settings takes short locks, recording queues to the
/// store's writer, and deliveries run on blocking workers.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut watch = HostOfflineWatch::new(OFFLINE_AFTER_MS, MAX_STEP_MS);
        let mut ticks = tokio::time::interval(POLL_PERIOD);
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticks.tick().await;
            if let Some(state) = app.try_state::<AppState>() {
                poll_once(&app, &state, &mut watch);
            }
        }
    });
}

/// One poll: observe the saved hosts when [`should_watch`] says so, else reset, and
/// fire what the watch reports as alerts of this Mac.
fn poll_once(app: &AppHandle, state: &AppState, watch: &mut HostOfflineWatch) {
    let rule_on = state.settings.settings().alerts.host_offline;
    let hosts = if rule_on {
        state.remotes.saved_statuses()
    } else {
        Vec::new()
    };
    if !should_watch(rule_on, hosts.len()) {
        watch.reset();
        return;
    }
    let events = host_watch::poll(watch, statglass_engine::wall_ms(), &hosts);
    if events.is_empty() {
        return;
    }
    let local = match state.host(state.local) {
        Ok(entry) => entry.record(),
        Err(error) => {
            tracing::warn!(?error, "host-offline alerts dropped: no local host");
            return;
        }
    };
    let sinks = ShellSinks::new(app, state, local);
    for event in &events {
        fire::record_and_announce(&sinks, event);
    }
}
