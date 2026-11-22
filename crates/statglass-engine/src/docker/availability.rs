//! What the snapshot says about an unreachable engine: why no engine answers, decided
//! from discovery facts, and how long the worker waits before its next attempt,
//! including the faster cadence after the user launches a runtime. The classifier and
//! the retry plan are pure; the handle methods at the bottom gather their inputs.
use statglass_collect::docker::now_ms;
use statglass_collect::docker_runtimes::{default_search_paths, installed_runtimes};
use statglass_schema::{
    docker::{
        DockerAvailability, DockerEngine, DockerRuntimeApp, DockerSettings, DockerUnavailableReason,
    },
    lock::LockExt,
};
use std::{sync::atomic::Ordering, time::Duration};
use tokio::time::Instant;

/// How long after a launch the engine retries on the fast cadence.
const LAUNCH_WINDOW: Duration = Duration::from_secs(60);
/// The retry wait while a launch window is open. It does not double.
const LAUNCH_RETRY: Duration = Duration::from_secs(2);
/// The first retry wait, in seconds, outside a launch window.
pub(super) const FIRST_RETRY_SECONDS: u64 = 1;
/// The longest retry wait, in seconds, outside a launch window.
const MAX_RETRY_SECONDS: u64 = 30;

/// The facts a failed connection attempt leaves behind.
#[derive(Clone, Copy, Debug)]
pub struct ReasonInput<'a> {
    /// Probed engines from discovery (`reachable` is meaningful).
    pub engines: &'a [DockerEngine],
    /// Runtimes installed on this Mac.
    pub runtimes: &'a [DockerRuntimeApp],
    /// The socket chosen in settings, if any.
    pub selected: Option<&'a str>,
    /// An engine answered earlier in this app session.
    pub was_connected: bool,
}

/// Classifies an unreachable engine.
///
/// Rules, first match wins:
/// 1. Two or more reachable engines, none preferred and none selected: `ChooseEngine`.
/// 2. A selected socket that discovery doesn't list, with no runtime installed:
///    `SelectedMissing`.
/// 3. An engine answered earlier this session: `Stopped`.
/// 4. No engines listed and no runtime installed: `NotInstalled`.
/// 5. Otherwise: `NotRunning`.
pub fn unavailable_reason(input: ReasonInput<'_>) -> DockerUnavailableReason {
    if needs_choice(&input) {
        return DockerUnavailableReason::ChooseEngine;
    }
    if selected_is_missing(&input) {
        return DockerUnavailableReason::SelectedMissing;
    }
    if input.was_connected {
        return DockerUnavailableReason::Stopped;
    }
    if input.engines.is_empty() && input.runtimes.is_empty() {
        return DockerUnavailableReason::NotInstalled;
    }
    DockerUnavailableReason::NotRunning
}

/// Rule 1: several engines answer and nothing says which one to monitor.
fn needs_choice(input: &ReasonInput<'_>) -> bool {
    let reachable = input.engines.iter().filter(|e| e.reachable).count();
    reachable >= 2 && input.selected.is_none() && !input.engines.iter().any(|e| e.preferred)
}

/// Rule 2: the chosen socket is gone and no installed runtime could bring it back.
fn selected_is_missing(input: &ReasonInput<'_>) -> bool {
    input.selected.is_some_and(|socket| {
        input.runtimes.is_empty() && !input.engines.iter().any(|e| e.socket == socket)
    })
}

/// The post-launch window: until it closes the engine retries every two seconds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct LaunchWindow {
    /// When the window closes, on the monotonic clock the retry wait uses.
    pub until: Instant,
    /// When the window closes, in wall-clock ms for the snapshot.
    pub until_ms: i64,
}

impl LaunchWindow {
    /// A window opening at `now` (monotonic) and `now_ms` (wall clock).
    pub fn opened_at(now: Instant, now_ms: i64) -> Self {
        let length_ms = i64::try_from(LAUNCH_WINDOW.as_millis())
            .expect("a 60 s window fits in i64 milliseconds");
        Self {
            until: now + LAUNCH_WINDOW,
            until_ms: now_ms.saturating_add(length_ms),
        }
    }

    /// Whether the window is still open at `now`.
    pub fn is_open(&self, now: Instant) -> bool {
        now < self.until
    }
}

/// The wait before the next connection attempt, and the backoff step after it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct RetryPlan {
    /// How long to wait now.
    pub delay: Duration,
    /// The backoff step, in seconds, to use for the attempt after this one.
    pub next_seconds: u64,
}

/// Plans the next retry wait from the current backoff step. While a launch window is
/// open the wait is a flat two seconds and the step resets, so normal backoff resumes
/// from one second once the window closes. Otherwise the step doubles up to 30 s.
pub(super) fn retry_plan(launching: bool, seconds: u64) -> RetryPlan {
    if launching {
        return RetryPlan {
            delay: LAUNCH_RETRY,
            next_seconds: FIRST_RETRY_SECONDS,
        };
    }
    RetryPlan {
        delay: Duration::from_secs(seconds),
        next_seconds: seconds.saturating_mul(2).min(MAX_RETRY_SECONDS),
    }
}

/// The handle's side of availability: the launch window it holds and the facts it
/// gathers when no engine answers.
impl super::DockerHandle {
    /// Starts the post-launch window: the engine retries every two seconds for
    /// sixty seconds and reports `launching_until_ms`, then reconnects now.
    pub fn launch_started(&self) {
        let window = LaunchWindow::opened_at(Instant::now(), now_ms());
        *self.launch.lock_ok() = Some(window);
        self.update(|s| {
            if let Some(availability) = &mut s.availability {
                availability.launching_until_ms = Some(window.until_ms);
            }
        });
        self.resume();
    }
    /// Docker runtimes installed on this Mac, in launch preference order. Reads a few
    /// fixed paths under `/Applications`, the user's home and the Homebrew bin folders.
    pub fn installed_runtimes(&self) -> Vec<DockerRuntimeApp> {
        installed_runtimes(&default_search_paths(&self.home))
    }
    /// The next retry wait from the backoff step, on the fast cadence while a launch
    /// window is open.
    pub(super) fn retry_plan(&self, seconds: u64) -> RetryPlan {
        let launching = self.open_launch_window().is_some();
        retry_plan(launching, seconds)
    }
    /// The launch window, if it is still open. An expired window is cleared.
    pub(super) fn open_launch_window(&self) -> Option<LaunchWindow> {
        let mut launch = self.launch.lock_ok();
        if launch.is_some_and(|window| !window.is_open(Instant::now())) {
            *launch = None;
        }
        *launch
    }
    /// Why no engine answers and when the worker tries again, `delay` from now.
    /// Probes every candidate engine so the reason reflects what answers right now.
    pub(super) async fn availability(
        &self,
        settings: &DockerSettings,
        delay: Duration,
    ) -> DockerAvailability {
        let engines = self.discover().await;
        let runtimes = self.installed_runtimes();
        let reason = unavailable_reason(ReasonInput {
            engines: &engines,
            runtimes: &runtimes,
            selected: settings.selected_engine.as_deref(),
            was_connected: self.was_connected.load(Ordering::SeqCst),
        });
        let delay_ms = i64::try_from(delay.as_millis()).unwrap_or(i64::MAX);
        DockerAvailability {
            reason,
            runtimes,
            next_attempt_ms: Some(now_ms().saturating_add(delay_ms)),
            launching_until_ms: self.open_launch_window().map(|window| window.until_ms),
        }
    }
}

#[cfg(test)]
mod tests;
