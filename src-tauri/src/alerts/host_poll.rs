//! The host-offline poll (plan/rfc-alerts.md 6.1, 6.6): every 30 seconds, while the
//! built-in host-offline rule is on and a remote host is saved, the saved hosts'
//! statuses go through [`host_watch::poll`] and every alert it returns is fired like
//! any other ([`fire::record_and_announce`]). With the rule off or no host saved the
//! watch is reset, so switching the rule back on starts every count again. At launch
//! the watch starts from the stored alerts, so a host already reported offline is not
//! announced again.
//!
//! The backgrounded app has a strict idle-CPU budget, so with nothing to watch the task
//! has no timer at all: it sleeps until `settings-changed` or `hosts-changed` is
//! emitted, then decides again. While watching, either event also wakes it early, so
//! switching the rule off resets the watch at once.

use std::sync::Arc;
use std::time::Duration;

use statglass_schema::{AlertRule, HostId};
use tauri::{AppHandle, Listener, Manager};
use tauri_specta::Event as _;
use tokio::sync::Notify;

use super::fire::{self, ShellSinks};
use super::host_offline::HostOfflineWatch;
use super::host_watch;
use crate::ipc::{HostsChanged, SettingsChanged};
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

/// How long the task sleeps after a poll before polling again on its own: one
/// [`POLL_PERIOD`] while watching, `None` (only a settings or host change wakes it)
/// otherwise.
pub fn next_wake(rule_on: bool, saved_hosts: usize) -> Option<Duration> {
    should_watch(rule_on, saved_hosts).then_some(POLL_PERIOD)
}

/// Starts the poll on the async runtime; it runs for the life of the app. Never
/// blocks: reading statuses and settings takes short locks, recording queues to the
/// store's writer, and deliveries run on blocking workers.
pub fn spawn(app: AppHandle) {
    let changed = Arc::new(Notify::new());
    for event in [SettingsChanged::NAME, HostsChanged::NAME] {
        let changed = Arc::clone(&changed);
        // `notify_one` keeps a permit when the task is mid-poll, so no change is missed.
        app.listen_any(event, move |_| changed.notify_one());
    }
    tauri::async_runtime::spawn(async move {
        let mut watch = HostOfflineWatch::new(OFFLINE_AFTER_MS, MAX_STEP_MS);
        if let Some(state) = app.try_state::<AppState>() {
            seed_from_history(&state, &mut watch);
        }
        loop {
            let wake = match app.try_state::<AppState>() {
                Some(state) => poll_once(&app, &state, &mut watch),
                None => None,
            };
            match wake {
                Some(period) => {
                    tokio::select! {
                        () = tokio::time::sleep(period) => {}
                        () = changed.notified() => {}
                    }
                }
                None => changed.notified().await,
            }
        }
    });
}

/// Starts `watch` with the saved hosts this Mac's stored alerts still report offline
/// ([`host_watch::reported_hosts`]), so a launch does not announce them again and
/// still sends their recovery. With history unavailable or unreadable nothing is
/// seeded and every count starts fresh.
fn seed_from_history(state: &AppState, watch: &mut HostOfflineWatch) {
    if !state.history.is_available() {
        tracing::debug!("history unavailable: the host-offline watch starts unseeded");
        return;
    }
    let now_ms = statglass_engine::wall_ms();
    let from_ms = now_ms.saturating_sub(host_watch::SEED_LOOK_BACK_MS);
    let stored = match state.history.alerts_since(state.local, from_ms, now_ms) {
        Ok(stored) => stored,
        Err(error) => {
            tracing::warn!(
                ?error,
                "reading host-offline alerts; the watch starts unseeded"
            );
            return;
        }
    };
    let saved: Vec<HostId> = state
        .remotes
        .saved_statuses()
        .iter()
        .map(|s| s.host)
        .collect();
    watch.seed(host_watch::reported_hosts(&stored, &saved, now_ms));
}

/// One poll: observe the saved hosts when [`should_watch`] says so, else reset, and
/// fire what the watch reports as alerts of this Mac. Returns [`next_wake`].
fn poll_once(app: &AppHandle, state: &AppState, watch: &mut HostOfflineWatch) -> Option<Duration> {
    let rule_on = state.settings.settings().alerts.host_offline;
    let hosts = if rule_on {
        state.remotes.saved_statuses()
    } else {
        Vec::new()
    };
    let wake = next_wake(rule_on, hosts.len());
    if wake.is_none() {
        watch.reset();
        return wake;
    }
    let events = host_watch::poll(watch, statglass_engine::wall_ms(), &hosts);
    if events.is_empty() {
        return wake;
    }
    let local = match state.host(state.local) {
        Ok(entry) => entry.record(),
        Err(error) => {
            tracing::warn!(?error, "host-offline alerts dropped: no local host");
            return wake;
        }
    };
    let sinks = ShellSinks::new(app, state, local);
    for event in &events {
        fire::record_and_announce(&sinks, event);
    }
    wake
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn with_nothing_to_watch_the_task_sets_no_timer() {
        assert_eq!(next_wake(false, 0), None);
        assert_eq!(next_wake(false, 2), None);
        assert_eq!(next_wake(true, 0), None);
    }

    #[test]
    fn while_watching_the_task_polls_again_after_one_period() {
        assert_eq!(next_wake(true, 1), Some(POLL_PERIOD));
        assert_eq!(next_wake(true, 4), Some(POLL_PERIOD));
    }
}
