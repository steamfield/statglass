//! Docker coverage records: what interrupted collection, saving or events, and whose
//! measurements each one masks (D-128).
use crate::JsSafeInt;
use serde::{Deserialize, Serialize};

/// One interruption of Docker coverage. `kind`, `masking` and `label` are derived from
/// `reason` and the scope by `DockerCoverage::new`, which deserializing also goes
/// through, and those fields are private in Rust, so they always agree (D-128).
#[derive(Clone, Debug, PartialEq, Serialize, specta::Type)]
pub struct DockerCoverage {
    #[specta(type = JsSafeInt)]
    pub start_ms: i64,
    #[specta(type = Option<JsSafeInt>)]
    pub end_ms: Option<i64>,
    pub container_id: Option<String>,
    /// The key records merge by; `kind`, `masking` and `label` derive from it (D-128).
    reason: String,
    kind: DockerCoverageKind,
    /// Whose history points count no measured time inside this record (D-128).
    masking: DockerCoverageMasking,
    label: String,
}
/// What a coverage record interrupted. `Collection` and `Metrics` mean nothing was
/// measured, so a history point counts no measured time inside them (D-128). `Other`
/// is a reason this build does not know, which says nothing about measurements.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum DockerCoverageKind {
    Collection,
    Saving,
    Metrics,
    Events,
    Other,
}
/// Which history points a record erases measured time from. A record with a
/// `container_id` only ever masks that container's points; an engine-wide one masks
/// every container's (`containers`) or those and the engine aggregate's (`all`).
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, specta::Type,
)]
#[serde(rename_all = "snake_case")]
pub enum DockerCoverageMasking {
    None,
    Containers,
    All,
}
impl DockerCoverageKind {
    /// Whether history points inside a record of this kind were measured.
    pub fn masks_measurements(self) -> bool {
        matches!(self, Self::Collection | Self::Metrics)
    }
}
impl DockerCoverage {
    /// The only constructor, so `kind` and `label` always follow `reason`.
    pub fn new(
        start_ms: i64,
        end_ms: Option<i64>,
        container_id: Option<String>,
        reason: String,
    ) -> Self {
        let (kind, label) = coverage_meaning(&reason);
        let masking = coverage_masking(kind, container_id.is_some(), &reason);
        Self {
            start_ms,
            end_ms,
            container_id,
            kind,
            masking,
            label: label.map_or_else(|| in_words(&reason), str::to_owned),
            reason,
        }
    }
    pub fn reason(&self) -> &str {
        &self.reason
    }
    pub fn kind(&self) -> DockerCoverageKind {
        self.kind
    }
    pub fn label(&self) -> &str {
        &self.label
    }
    pub fn masking(&self) -> DockerCoverageMasking {
        self.masking
    }
    /// Whether history points of `container` (`None`: the engine aggregate) count no
    /// measured time inside this record.
    pub fn masks(&self, container: Option<&str>) -> bool {
        let scoped = self
            .container_id
            .as_deref()
            .is_none_or(|id| container == Some(id));
        match self.masking {
            DockerCoverageMasking::None => false,
            DockerCoverageMasking::Containers => scoped && container.is_some(),
            DockerCoverageMasking::All => scoped,
        }
    }
}
impl<'de> Deserialize<'de> for DockerCoverage {
    /// Rebuilds through [`DockerCoverage::new`]; a serialized `kind` or `label` is ignored.
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Record {
            start_ms: i64,
            end_ms: Option<i64>,
            container_id: Option<String>,
            reason: String,
        }
        let r = Record::deserialize(deserializer)?;
        Ok(Self::new(r.start_ms, r.end_ms, r.container_id, r.reason))
    }
}
/// "write_rejected" as "Write rejected".
fn in_words(key: &str) -> String {
    let words = key.replace('_', " ");
    let mut chars = words.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}
/// A container's record masks only that container. An engine-wide `inventory_failed`
/// masks every container but not the aggregate, which already gives no weight to a
/// cycle that measured fewer containers than expected. An engine-wide `partial_cycle`,
/// which earlier builds wrote when any one container failed, masks nothing for the
/// same reason.
fn coverage_masking(kind: DockerCoverageKind, scoped: bool, reason: &str) -> DockerCoverageMasking {
    if !kind.masks_measurements() || !scoped && reason == "partial_cycle" {
        DockerCoverageMasking::None
    } else if scoped || reason == "inventory_failed" {
        DockerCoverageMasking::Containers
    } else {
        DockerCoverageMasking::All
    }
}
/// A reason this build does not know (a newer build's, read after a downgrade) is
/// `Other`, labelled with its key in words, so it never erases measured time.
fn coverage_meaning(reason: &str) -> (DockerCoverageKind, Option<&'static str>) {
    use DockerCoverageKind::{Collection, Events, Metrics, Other, Saving};
    match reason {
        "disconnected" => (Collection, Some("Lost connection to Docker")),
        "disabled" => (Collection, Some("Docker monitoring was off")),
        "paused" => (Collection, Some("Monitoring was paused")),
        "idle_suspended" => (
            Collection,
            Some("Monitoring paused while no containers ran"),
        ),
        "engine_switch" => (Collection, Some("Monitoring switched Docker engines")),
        "shutdown" => (Collection, Some("StatGlass was not running")),
        // Current-state records the engine publishes beside the snapshot's status.
        "unavailable" => (Collection, Some("Docker is unavailable")),
        "permission_denied" => (Collection, Some("Docker refused access")),
        "incompatible" => (Collection, Some("This Docker version is not supported")),
        "partial_population" => (
            Collection,
            Some("Some running containers are not monitored"),
        ),
        // Present tense: the snapshot's own records of its current state.
        "monitoring_paused" => (Collection, Some("Monitoring is paused")),
        "monitoring_idle" => (
            Collection,
            Some("Monitoring is paused while no containers run"),
        ),
        "partial_cycle" => (Metrics, Some("Some containers were not measured")),
        "inventory_failed" => (Metrics, Some("Docker did not list its containers")),
        "clock_step" => (Metrics, Some("The Mac's clock changed")),
        "coverage_unknown" => (Metrics, Some("Too many interruptions to list")),
        "write_failed" => (Saving, Some("Measurements could not be saved")),
        "writer_disconnected" => (Saving, Some("History writer stopped")),
        "ring_capacity" => (Saving, Some("Recent measurements outgrew memory")),
        "metadata_oversized" => (Saving, Some("Container details too large to save")),
        "metadata_capacity" => (Saving, Some("Container details could not be kept")),
        "events_disconnected" => (Events, Some("Lost connection to Docker events")),
        "event_replay_uncertain" => (
            Events,
            Some("Some events may be missing after reconnecting"),
        ),
        "events_dropped_rate_limit" => (Events, Some("Events arrived too fast; some were dropped")),
        "restart_evidence_dropped" => (Events, Some("Some restart events were dropped")),
        _ => (Other, None),
    }
}
