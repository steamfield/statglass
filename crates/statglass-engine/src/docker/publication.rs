//! Source-derived aggregate presentation and snapshot publication.
use super::*;
pub(super) fn unavailable_runtime(runtime: &str) -> DockerRuntimeFootprint {
    DockerRuntimeFootprint{scope:if runtime=="OrbStack"{"shared"}else{"unavailable"}.into(),explanation:if runtime=="OrbStack"{"OrbStack shares its runtime with other workloads. Docker-only process attribution has not been verified."}else{"Runtime process attribution is unavailable; container metrics do not measure the Mac runtime's footprint."}.into(),cpu_pct:None,footprint_bytes:None,observed_ms:None,processes:Vec::new()}
}
/// `unmeasured` are the containers this cycle failed to measure: their rows still hold
/// an earlier cycle's reading, which is not fresh.
pub(super) fn aggregate(
    rows: &[DockerContainer],
    unmeasured: &BTreeSet<String>,
    capacity: Option<f64>,
    inventory_complete: bool,
    now: i64,
    interval: u32,
) -> DockerAggregate {
    aggregate_rows(
        rows.iter(),
        unmeasured,
        capacity,
        inventory_complete,
        now,
        interval,
    )
}
pub(super) fn project_aggregates(
    rows: &[DockerContainer],
    unmeasured: &BTreeSet<String>,
    capacity: Option<f64>,
    inventory_complete: bool,
    now: i64,
    interval: u32,
) -> Vec<DockerProjectAggregate> {
    let mut projects: BTreeMap<Option<String>, Vec<&DockerContainer>> = BTreeMap::new();
    for row in rows {
        projects.entry(row.project.clone()).or_default().push(row);
    }
    projects
        .into_iter()
        .map(|(project, rows)| DockerProjectAggregate {
            project,
            aggregate: aggregate_rows(
                rows.iter().copied(),
                unmeasured,
                capacity,
                inventory_complete,
                now,
                interval,
            ),
        })
        .collect()
}
pub(super) fn aggregate_rows<'a>(
    rows: impl Iterator<Item = &'a DockerContainer> + Clone,
    unmeasured: &BTreeSet<String>,
    capacity: Option<f64>,
    inventory_complete: bool,
    now: i64,
    interval: u32,
) -> DockerAggregate {
    let running = rows
        .clone()
        .filter(|c| c.lifecycle == DockerLifecycle::Running)
        .count() as u32;
    let expected = rows
        .clone()
        .filter(|c| c.monitored && c.lifecycle == DockerLifecycle::Running)
        .count() as u32;
    let fresh = |c: &&DockerContainer| {
        c.monitored
            && c.lifecycle == DockerLifecycle::Running
            && !unmeasured.contains(&c.id)
            && c.observed_ms
                .is_some_and(|t| now.saturating_sub(t) <= interval.max(5000) as i64 * 2)
    };
    let cpu: Vec<_> = rows
        .clone()
        .filter(fresh)
        .filter_map(|c| c.metrics.cpu_pct)
        .collect();
    let memory: Vec<_> = rows
        .clone()
        .filter(fresh)
        .filter_map(|c| c.metrics.working_set_bytes)
        .collect();
    DockerAggregate {
        monitoring_limit: 128,
        cpu_cores: (!cpu.is_empty()).then(|| cpu.iter().sum::<f64>() / 100.),
        working_set_bytes: (!memory.is_empty()).then(|| memory.iter().sum()),
        capacity_bytes: capacity,
        cpu_measured: cpu.len() as u32,
        memory_measured: memory.len() as u32,
        expected,
        running,
        total: rows.clone().count() as u32,
        monitored: rows.clone().filter(|c| c.monitored).count() as u32,
        partial: expected < running
            || cpu.len() < expected as usize
            || memory.len() < expected as usize
            || !inventory_complete,
        inventory_complete,
    }
}

/// Open records for what the snapshot's state interrupts now, from its last
/// observation. They describe the present and are never recorded.
pub(super) fn current_coverage(s: &DockerSnapshot) -> Vec<DockerCoverage> {
    let status = match s.status {
        DockerStatus::Unavailable => Some("unavailable"),
        DockerStatus::PermissionDenied => Some("permission_denied"),
        DockerStatus::Incompatible => Some("incompatible"),
        // Not the recorded "paused" and "idle_suspended", which are past intervals.
        DockerStatus::Paused => Some("monitoring_paused"),
        DockerStatus::IdleSuspended => Some("monitoring_idle"),
        _ => None,
    };
    let saving = s.persistence.status == "write_failed";
    let unmonitored = s.status == DockerStatus::Connected
        && (s.aggregate.expected < s.aggregate.running || !s.aggregate.inventory_complete);
    [
        status,
        saving.then_some("write_failed"),
        unmonitored.then_some("partial_population"),
    ]
    .into_iter()
    .flatten()
    .map(|reason| DockerCoverage::new(s.observed_ms, None, None, reason.into()))
    .collect()
}
/// The engine-wide record still open in a record's lane: event coverage, or what
/// interrupts measurements. Each lane holds at most one, and neither closes the other.
pub(super) fn open_engine_wide(
    coverage: &mut [DockerCoverage],
    events: bool,
) -> Option<&mut DockerCoverage> {
    coverage.iter_mut().rev().find(|g| {
        g.container_id.is_none()
            && g.end_ms.is_none()
            && (g.kind() == DockerCoverageKind::Events) == events
    })
}
/// A published cycle ends the open event record and the open measurement record,
/// unless that is still true: a failed inventory refresh opens one `inventory_failed`
/// record for the whole engine, not one per container, and a listed cycle whose
/// aggregate missed containers (`holes`) keeps one `aggregate_partial` open.
pub(super) fn reconcile_cycle(
    coverage: &mut Vec<DockerCoverage>,
    listed: bool,
    holes: bool,
    at: i64,
) {
    if let Some(g) = open_engine_wide(coverage, true) {
        g.end_ms = Some(at.max(g.start_ms));
    }
    let wanted = if !listed {
        Some("inventory_failed")
    } else {
        holes.then_some("aggregate_partial")
    };
    if let Some(g) = open_engine_wide(coverage, false) {
        if wanted == Some(g.reason()) {
            return;
        }
        g.end_ms = Some(at.max(g.start_ms));
    }
    if let Some(reason) = wanted {
        coverage.push(DockerCoverage::new(at, None, None, reason.into()));
    }
}
/// The published records as the recorder keeps them after a clock step to `at`
/// (`DockerRecorder::clock_step`): records that start at or after the step are gone,
/// and every other record ends by it. The next cycle reopens what still fails.
pub(super) fn step_coverage(coverage: &mut Vec<DockerCoverage>, at: i64) {
    coverage.retain(|g| g.start_ms < at);
    for g in coverage {
        if g.end_ms.is_none_or(|end| end > at) {
            g.end_ms = Some(at);
        }
    }
}
/// One open `partial_cycle` record per container whose stats failed this cycle; a
/// container that was measured, stopped or left the population closes its record.
pub(super) fn reconcile_partial(
    coverage: &mut Vec<DockerCoverage>,
    failed: &BTreeSet<String>,
    at: i64,
) {
    let mut open = BTreeSet::new();
    for g in coverage
        .iter_mut()
        .filter(|g| g.end_ms.is_none() && g.reason() == "partial_cycle" && g.container_id.is_some())
    {
        match g.container_id.as_ref().filter(|id| failed.contains(*id)) {
            Some(id) => {
                open.insert(id.clone());
            }
            None => g.end_ms = Some(at.max(g.start_ms)),
        }
    }
    coverage.extend(
        failed
            .difference(&open)
            .map(|id| DockerCoverage::new(at, None, Some(id.clone()), "partial_cycle".into())),
    );
}
/// Opens an engine-wide `gap`, closing the one open before it in its lane. A
/// collection interruption ends everything open: both lanes and each container's
/// partial cycle.
pub(super) fn open_gap(coverage: &mut Vec<DockerCoverage>, gap: DockerCoverage) {
    let collection = gap.kind() == DockerCoverageKind::Collection;
    let events = gap.kind() == DockerCoverageKind::Events;
    for g in coverage.iter_mut().filter(|g| {
        g.end_ms.is_none()
            && (collection
                || g.container_id.is_none() && (g.kind() == DockerCoverageKind::Events) == events)
    }) {
        g.end_ms = Some(gap.start_ms.max(g.start_ms));
    }
    coverage.push(gap);
    bound_published(coverage);
}
/// Past 128 records, the oldest closed ones go until 64 closed remain. Open records
/// stay: the recorder must see them close.
pub(super) fn bound_published(coverage: &mut Vec<DockerCoverage>) {
    if coverage.len() <= 128 {
        return;
    }
    let closed = coverage.iter().filter(|g| g.end_ms.is_some()).count();
    let mut excess = closed.saturating_sub(64);
    coverage.retain(|g| {
        if excess > 0 && g.end_ms.is_some() {
            excess -= 1;
            return false;
        }
        true
    });
}

impl DockerHandle {
    pub(super) fn publish_cycle(
        &self,
        adapter: &DockerAdapter,
        control: &Control,
        inventory: &mut Inventory,
        restarts: &mut BTreeMap<String, VecDeque<i64>>,
        last_observation: &mut Option<Instant>,
        (listed, failed): (bool, &BTreeSet<String>),
    ) {
        let interval = control
            .min_interval_ms
            .max(if control.visible > 0 { 1000 } else { 10000 });
        let observed = now_ms();
        for row in &mut inventory.rows {
            let n = restarts
                .get_mut(&row.id)
                .map(|q| {
                    q.retain(|t| *t >= observed - 300000);
                    q.len() as u32
                })
                .unwrap_or(0);
            row.observed_restarts = n;
            row.repeated_restarts = n >= 3;
        }
        let mut snapshot = self.snapshot();
        snapshot.generation = control.generation;
        snapshot.status = DockerStatus::Connected;
        snapshot.message = None;
        snapshot.engine = Some(adapter.engine.clone());
        snapshot.runtime = unavailable_runtime(&adapter.engine.runtime);
        snapshot.settings = control.settings.clone();
        snapshot.observed_ms = observed;
        let observed_mono = Instant::now();
        snapshot.interval_ms = last_observation
            .map(|t| {
                observed_mono
                    .duration_since(t)
                    .as_millis()
                    .min(u32::MAX as u128) as u32
            })
            .unwrap_or(0);
        *last_observation = Some(observed_mono);
        snapshot.population_revision = inventory.revision;
        // Receipt time differs per request; preserve it and publish source intervals.
        snapshot.containers = inventory.rows.clone();
        // A failed inventory refresh requested no stats: nothing running was measured.
        let unmeasured = if listed {
            failed.clone()
        } else {
            inventory
                .rows
                .iter()
                .filter(|c| c.monitored && c.lifecycle == DockerLifecycle::Running)
                .map(|c| c.id.clone())
                .collect()
        };
        snapshot.aggregate = aggregate(
            &inventory.rows,
            &unmeasured,
            adapter.engine.capacity_bytes,
            inventory.complete,
            observed,
            interval,
        );
        snapshot.project_aggregates = project_aggregates(
            &inventory.rows,
            &unmeasured,
            adapter.engine.capacity_bytes,
            inventory.complete,
            observed,
            interval,
        );
        // Containers whose stats failed this cycle carry their own records; the
        // aggregate's unweighted cycle gets one engine-wide record that masks nothing.
        // A first sample (no CPU baseline yet, interval 0) is routine, not a hole.
        let first = inventory
            .rows
            .iter()
            .filter(|c| {
                c.monitored
                    && c.lifecycle == DockerLifecycle::Running
                    && !unmeasured.contains(&c.id)
                    && c.interval_ms == Some(0)
                    && c.metrics.cpu_pct.is_none()
            })
            .count();
        let first = u32::try_from(first).unwrap_or(u32::MAX);
        let holes = snapshot.aggregate.cpu_measured.saturating_add(first)
            < snapshot.aggregate.expected
            || snapshot.aggregate.memory_measured < snapshot.aggregate.expected;
        reconcile_cycle(&mut snapshot.coverage, listed, holes, observed);
        reconcile_partial(&mut snapshot.coverage, failed, observed);
        bound_published(&mut snapshot.coverage);
        self.publish(snapshot);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(start: i64, end: Option<i64>, id: Option<&str>, reason: &str) -> DockerCoverage {
        DockerCoverage::new(start, end, id.map(Into::into), reason.into())
    }
    fn ids(ids: &[&str]) -> BTreeSet<String> {
        ids.iter().map(|id| (*id).to_owned()).collect()
    }

    #[test]
    fn only_the_containers_that_failed_carry_partial_cycles() {
        let mut coverage = vec![record(1, None, None, "events_disconnected")];
        reconcile_partial(&mut coverage, &ids(&["a", "b"]), 10);
        reconcile_partial(&mut coverage, &ids(&["b"]), 20);
        reconcile_partial(&mut coverage, &ids(&["b", "c"]), 30);
        assert_eq!(
            coverage,
            [
                record(1, None, None, "events_disconnected"),
                record(10, Some(20), Some("a"), "partial_cycle"),
                record(10, None, Some("b"), "partial_cycle"),
                record(30, None, Some("c"), "partial_cycle"),
            ]
        );
        reconcile_partial(&mut coverage, &BTreeSet::new(), 40);
        assert!(coverage.iter().skip(1).all(|g| g.end_ms.is_some()));
    }

    #[test]
    fn event_and_measurement_records_keep_their_own_open_slot() {
        let mut coverage = vec![record(0, None, None, "inventory_failed")];
        open_gap(
            &mut coverage,
            record(5, None, None, "events_dropped_rate_limit"),
        );
        assert_eq!(
            coverage[0].end_ms, None,
            "an event record closed the inventory's"
        );
        // The inventory fails again: one record, and the cycle ends the event record.
        reconcile_cycle(&mut coverage, false, true, 10);
        assert_eq!(
            coverage,
            [
                record(0, None, None, "inventory_failed"),
                record(5, Some(10), None, "events_dropped_rate_limit"),
            ]
        );
        // Listed, but the aggregate missed containers; then it measured them all.
        reconcile_cycle(&mut coverage, true, true, 20);
        reconcile_cycle(&mut coverage, true, true, 25);
        reconcile_cycle(&mut coverage, true, false, 30);
        assert_eq!(
            coverage[2..],
            [record(20, Some(30), None, "aggregate_partial")]
        );
        assert_eq!(coverage[0].end_ms, Some(20));
        // A collection interruption still ends everything open.
        open_gap(&mut coverage, record(40, None, None, "events_disconnected"));
        open_gap(&mut coverage, record(50, None, None, "disconnected"));
        assert_eq!(coverage.iter().filter(|g| g.end_ms.is_none()).count(), 1);
    }

    #[test]
    fn bounding_the_published_coverage_keeps_open_records() {
        let mut coverage: Vec<_> = (0..200)
            .map(|i| record(i, Some(i + 1), Some("a"), "partial_cycle"))
            .collect();
        coverage.insert(0, record(0, None, Some("b"), "partial_cycle"));
        bound_published(&mut coverage);
        assert_eq!(coverage.len(), 65);
        assert_eq!(coverage[0], record(0, None, Some("b"), "partial_cycle"));
        assert_eq!(coverage[1].start_ms, 136);
    }

    #[test]
    fn current_coverage_follows_status_saving_and_population() {
        let handle = DockerHandle::new(
            HostId(uuid::Uuid::new_v4()),
            DockerSettings::default(),
            std::path::PathBuf::new(),
        );
        let mut s = handle.snapshot();
        s.observed_ms = 5;
        let reasons = |s: &DockerSnapshot| {
            current_coverage(s)
                .into_iter()
                .map(|g| (g.reason().to_owned(), g.start_ms, g.end_ms))
                .collect::<Vec<_>>()
        };
        assert!(reasons(&s).is_empty(), "disabled is not an interruption");
        // The present state reads in the present tense, unlike the recorded interval.
        let label = |s: &DockerSnapshot| current_coverage(s)[0].label().to_owned();
        s.status = DockerStatus::Paused;
        assert_eq!(label(&s), "Monitoring is paused");
        s.status = DockerStatus::IdleSuspended;
        assert_eq!(label(&s), "Monitoring is paused while no containers run");
        s.status = DockerStatus::PermissionDenied;
        s.persistence.status = "write_failed".into();
        assert_eq!(
            reasons(&s),
            [
                ("permission_denied".into(), 5, None),
                ("write_failed".into(), 5, None)
            ]
        );
        s.status = DockerStatus::Connected;
        s.persistence.status = "recording".into();
        s.aggregate.inventory_complete = true;
        s.aggregate.running = 3;
        s.aggregate.expected = 2;
        assert_eq!(reasons(&s), [("partial_population".into(), 5, None)]);
        assert_eq!(
            current_coverage(&s)[0].label(),
            "Some running containers are not monitored"
        );
    }

    #[test]
    fn a_collection_gap_closes_each_containers_partial_cycle() {
        let handle = DockerHandle::new(
            HostId(uuid::Uuid::new_v4()),
            DockerSettings::default(),
            std::path::PathBuf::new(),
        );
        handle.changed.send_modify(|s| {
            s.coverage = vec![record(1, None, Some("a"), "partial_cycle")];
        });
        handle.gap("events_disconnected");
        assert!(handle.snapshot().coverage[0].end_ms.is_none());
        handle.gap("shutdown");
        let coverage = handle.snapshot().coverage;
        assert!(coverage[0].end_ms.is_some());
        assert!(coverage[1].end_ms.is_some(), "events gap left open");
        assert_eq!(coverage[2].reason(), "shutdown");
        assert_eq!(coverage[2].end_ms, None);
    }
}
