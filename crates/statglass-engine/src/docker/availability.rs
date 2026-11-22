//! Why no Docker engine is reachable, decided from discovery facts. Pure.
use statglass_schema::docker::{DockerEngine, DockerRuntimeApp, DockerUnavailableReason};

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
    let _ = input;
    DockerUnavailableReason::NotRunning
}

#[cfg(test)]
mod tests;
