//! Weighted bucket folding and bounded history-point projection.
use super::*;

pub(super) fn fold_ring(ring: &[Arc<db::DockerBucket>], tier: Tier) -> Vec<db::DockerBucket> {
    let width = tier.bucket_ms().unwrap_or(10_000);
    let mut out: BTreeMap<i64, db::DockerBucket> = BTreeMap::new();
    for b in ring {
        let time = floor_to(b.bucket_ms, width);
        let dst = out.entry(time).or_insert_with(|| db::DockerBucket {
            entity: b.entity.clone(),
            tier,
            bucket_ms: time,
            revision: 0,
            metrics: Vec::new(),
            populations: Vec::new(),
        });
        dst.revision = dst.revision.max(b.revision.abs());
        for m in &b.metrics {
            if let Some(old) = dst.metrics.iter_mut().find(|v| v.key == m.key) {
                let _ = old.merge(m);
            } else {
                dst.metrics.push(m.clone());
            }
        }
        dst.populations.extend(b.populations.clone());
    }
    for b in out.values_mut() {
        for m in &mut b.metrics {
            m.expected_ms = width as u64;
        }
    }
    out.into_values().collect()
}
pub(super) fn point(b: &db::DockerBucket) -> api::DockerHistoryPoint {
    let v = |key: &str| {
        b.metrics
            .iter()
            .find(|m| m.key == key)
            .and_then(db::WeightedMetric::average)
    };
    let measured = |key: &str| {
        b.metrics
            .iter()
            .find(|m| m.key == key)
            .map_or(0, |m| m.weight_ms.min(u32::MAX as u64) as u32)
    };
    let minimum = |key: &str| {
        b.metrics
            .iter()
            .find(|m| m.key == key && m.weight_ms > 0)
            .map(|m| m.min)
    };
    let peak = |key: &str| {
        b.metrics
            .iter()
            .find(|m| m.key == key && m.weight_ms > 0)
            .map(|m| m.max)
    };
    let expected = b
        .metrics
        .iter()
        .map(|m| m.expected_ms)
        .max()
        .unwrap_or_else(|| b.tier.bucket_ms().unwrap_or(10_000) as u64)
        .min(u32::MAX as u64) as u32;
    // RFC docker-monitoring-ux Bug 1: 52–54% of real buckets miss <=100 ms.
    const COVERAGE_TOLERANCE_DIVISOR: u32 = 50;
    let covered = |weight: u32| {
        weight > 0 && weight.saturating_add(expected / COVERAGE_TOLERANCE_DIVISOR) >= expected
    };
    let cpu_measured_ms = measured("cpu_percent");
    let memory_measured_ms = measured("memory_working_set");
    api::DockerHistoryPoint {
        time_ms: b.bucket_ms,
        duration_ms: expected,
        metrics: api::DockerMetrics {
            cpu_pct: v("cpu_percent"),
            working_set_bytes: v("memory_working_set"),
            raw_memory_bytes: v("memory_raw"),
            effective_limit_bytes: v("memory_limit"),
            network_rx_bps: v("network_rx"),
            network_tx_bps: v("network_tx"),
            block_read_bps: v("block_read"),
            block_write_bps: v("block_write"),
        },
        cpu_measured_ms,
        memory_measured_ms,
        expected_ms: expected,
        cpu_covered: covered(cpu_measured_ms),
        memory_covered: covered(memory_measured_ms),
        peak: api::DockerMetrics {
            cpu_pct: peak("cpu_percent"),
            working_set_bytes: peak("memory_working_set"),
            raw_memory_bytes: peak("memory_raw"),
            effective_limit_bytes: peak("memory_limit"),
            network_rx_bps: peak("network_rx"),
            network_tx_bps: peak("network_tx"),
            block_read_bps: peak("block_read"),
            block_write_bps: peak("block_write"),
        },
        minimum: api::DockerMetrics {
            cpu_pct: minimum("cpu_percent"),
            working_set_bytes: minimum("memory_working_set"),
            raw_memory_bytes: minimum("memory_raw"),
            effective_limit_bytes: minimum("memory_limit"),
            network_rx_bps: minimum("network_rx"),
            network_tx_bps: minimum("network_tx"),
            block_read_bps: minimum("block_read"),
            block_write_bps: minimum("block_write"),
        },
        population_revision: b.populations.last().map_or(0, |p| p.revision),
        revision: b.revision.abs(),
        explicit_limit_bytes: None,
        engine_capacity_bytes: None,
    }
}
pub(super) fn display_points(
    q: &api::DockerHistoryRequest,
    tier: Tier,
    mut buckets: BTreeMap<i64, db::DockerBucket>,
) -> Result<Vec<api::DockerHistoryPoint>, DockerServiceError> {
    let width = tier.bucket_ms().unwrap_or(10_000);
    let mut display_width = width;
    while buckets.len() > q.max_points as usize {
        display_width = display_width.saturating_mul(2);
        let mut coarse: BTreeMap<i64, db::DockerBucket> = BTreeMap::new();
        for b in buckets.into_values() {
            let at = floor_to(b.bucket_ms, display_width);
            let target = coarse.entry(at).or_insert_with(|| db::DockerBucket {
                entity: b.entity.clone(),
                tier,
                bucket_ms: at,
                revision: 0,
                metrics: Vec::new(),
                populations: Vec::new(),
            });
            target.revision = target.revision.max(b.revision);
            for m in b.metrics {
                if let Some(old) = target.metrics.iter_mut().find(|old| old.key == m.key) {
                    old.merge(&m)?;
                } else {
                    target.metrics.push(m);
                }
            }
            target.populations.extend(b.populations);
        }
        for b in coarse.values_mut() {
            for m in &mut b.metrics {
                m.expected_ms = display_width as u64;
            }
        }
        buckets = coarse;
    }
    let mut points = Vec::new();
    for b in buckets.into_values() {
        let mut p = point(&b);
        p.duration_ms = display_width.min(i64::from(u32::MAX)) as u32;
        p.expected_ms = p.duration_ms;
        points.push(p);
    }
    if points.len() > q.max_points as usize {
        return Err(DockerServiceError::InvalidRequest(
            "Select a coarser history range or more points",
        ));
    }
    Ok(points)
}
/// No point claims more measured time than the records that mask its container
/// (`DockerCoverage::masks`) leave in its bucket (D-128). A bucket a record touches is
/// not covered; one a record spans has no measured time. Open records run to the end of
/// the range: the recorder closes a crashed process's open rows when it restarts.
/// Each point's masked time, the union of the spans added to it. Spans must arrive in
/// start order: then a span's part inside a point starts no earlier than any earlier
/// span's part, so the union is a running total past the furthest end so far, and the
/// fold holds two numbers per point however many records a read streams.
pub(super) struct Mask {
    spans: Vec<(i64, i64)>,
    masked: Vec<i64>,
    reached: Vec<i64>,
}
impl Mask {
    pub(super) fn new(points: &[api::DockerHistoryPoint]) -> Self {
        let spans: Vec<_> = points
            .iter()
            .map(|p| {
                (
                    p.time_ms,
                    p.time_ms.saturating_add(i64::from(p.duration_ms)),
                )
            })
            .collect();
        Self {
            masked: vec![0; spans.len()],
            reached: spans.iter().map(|(start, _)| *start).collect(),
            spans,
        }
    }
    /// Adds `[start, end)`; `start` is no earlier than any span added before.
    pub(super) fn add(&mut self, start: i64, end: i64) {
        let first = self.spans.partition_point(|(_, to)| *to <= start);
        for (i, &(from, to)) in self.spans.iter().enumerate().skip(first) {
            if from >= end {
                break;
            }
            let (Some(masked), Some(reached)) = (self.masked.get_mut(i), self.reached.get_mut(i))
            else {
                break;
            };
            let clipped = start.max(*reached);
            let stop = end.min(to);
            if stop > clipped {
                *masked += stop - clipped;
                *reached = stop;
            }
        }
    }
    pub(super) fn apply(self, points: &mut [api::DockerHistoryPoint]) {
        for ((p, masked), (from, to)) in points.iter_mut().zip(self.masked).zip(self.spans) {
            if masked == 0 {
                continue;
            }
            let left = u32::try_from(to - from - masked).unwrap_or(0);
            p.cpu_measured_ms = p.cpu_measured_ms.min(left);
            p.memory_measured_ms = p.memory_measured_ms.min(left);
            p.cpu_covered = false;
            p.memory_covered = false;
        }
    }
}
