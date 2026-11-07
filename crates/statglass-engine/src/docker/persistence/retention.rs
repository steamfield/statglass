//! Account for ring, reader and retry ownership; evict only unpinned evidence.
use super::*;

pub(super) fn bucket_bytes(b: &db::DockerBucket) -> usize {
    256 + b.entity.len()
        + b.metrics.iter().map(|m| 80 + m.key.len()).sum::<usize>()
        + b.populations.len() * 32
}
pub(super) fn evict_entry(s: &mut State, key: &Key) {
    if let Some(e) = s.entries.remove(key) {
        s.bytes = s.bytes.saturating_sub(e.bytes);
        if e.bucket.revision > e.durable {
            let revision = next(s);
            let coverage = db::DockerCoverage {
                // Empty ID is the engine aggregate, not engine-wide coverage.
                entity: Some(key.1.clone()),
                metric: None,
                start_ms: key.2,
                end_ms: Some(key.2 + DOCKER_BUCKET_MS),
                reason: "write_failed".into(),
                revision,
                sampled_ms: 0,
                expected_ms: DOCKER_BUCKET_MS,
            };
            let mut retry = Retry::default();
            if let Some(fact) = s.facts.get(&(key.0.clone(), key.1.clone())) {
                retry.entities.push(fact.clone());
            }
            retry.coverage.push(coverage);
            requeue(s, &key.0, retry);
        }
    }
}
/// Records a closed engine-wide interruption the recorder found itself (a full ring,
/// oversized metadata, a lost writer). It merges only into the same reason's record
/// when that one is open or touches it, never across an hour of good time, and it is
/// saved through the retry queue, since no batch is at hand.
pub(super) fn gap(s: &mut State, engine: &str, start: i64, end: i64, reason: &str) {
    let gaps = s.coverage.entry(engine.into()).or_default();
    let record = match gaps.iter_mut().find(|g| {
        g.reason() == reason
            && g.container_id.is_none()
            && g.start_ms <= end
            && g.end_ms.is_none_or(|old| old >= start)
    }) {
        Some(old) => {
            old.start_ms = old.start_ms.min(start);
            old.end_ms = old.end_ms.map(|old| old.max(end));
            old.clone()
        }
        None => {
            let record = api::DockerCoverage::new(start, Some(end), None, reason.into());
            gaps.push(record.clone());
            record
        }
    };
    let row = coverage_row(s, &record, end);
    requeue(
        s,
        engine,
        Retry {
            coverage: vec![row],
            ..Retry::default()
        },
    );
    let held = held_coverage(s, engine);
    let live_only = s.live_only;
    if let Some(gaps) = s.coverage.get_mut(engine) {
        bound_coverage(gaps, &held, live_only);
    }
}
/// The store row for a record.
pub(super) fn coverage_row(s: &mut State, c: &api::DockerCoverage, now: i64) -> db::DockerCoverage {
    db::DockerCoverage {
        entity: c.container_id.clone(),
        metric: None,
        start_ms: c.start_ms,
        end_ms: c.end_ms,
        reason: c.reason().to_owned(),
        revision: next(s),
        sampled_ms: 0,
        // A transition can open a gap after the last metric snapshot.
        // Its still-open duration is zero until a newer observation.
        expected_ms: c.end_ms.unwrap_or(now).saturating_sub(c.start_ms).max(0),
    }
}
/// Closed records memory need not list: the store acknowledged them, or a write in
/// flight or a retry holds them, and every read merges both (`live_coverage`).
pub(super) fn held_coverage(s: &State, engine: &str) -> BTreeSet<CoverageKey> {
    let mut held = written_coverage(s, engine);
    held.extend(s.saved_coverage.get(engine).into_iter().flatten().cloned());
    held
}
/// Keep at most 512 records where possible: room for the published snapshot's own bound
/// (128 closed plus an open record per monitored container) and the recorder's own
/// saving records. Open records are never touched: they still have to close. Closed
/// records the store or a write holds (`held`) go first, then closed ones that mask
/// nothing, oldest first: every read merges the store's rows and the writes', so
/// dropping them changes no answer. With a store attached nothing else goes until
/// 4,096. Only then, or in live-only mode where memory is the only copy, do closed
/// masking records collapse, into one `coverage_unknown` span per container scope, so
/// a collapse only masks time its own scope already lost somewhere in that span.
pub(super) fn bound_coverage(
    gaps: &mut Vec<api::DockerCoverage>,
    held: &BTreeSet<CoverageKey>,
    live_only: bool,
) {
    const LIMIT: usize = 512;
    const ATTACHED_LIMIT: usize = 4096;
    if gaps.len() <= LIMIT {
        return;
    }
    let masking = |g: &api::DockerCoverage| g.masking() != api::DockerCoverageMasking::None;
    let is_held = |g: &api::DockerCoverage| coverage_key(g).is_some_and(|key| held.contains(&key));
    let excess = gaps.len() - LIMIT;
    let mut by_start: Vec<_> = gaps
        .iter()
        .filter(|g| g.end_ms.is_some() && (is_held(g) || !masking(g)))
        .map(|g| ((!is_held(g), g.start_ms), g.clone()))
        .collect();
    by_start.sort_by_key(|(order, _)| *order);
    let dropped: Vec<_> = by_start.into_iter().take(excess).map(|(_, g)| g).collect();
    gaps.retain(|g| !dropped.contains(g));
    let limit = if live_only { LIMIT } else { ATTACHED_LIMIT };
    if gaps.len() <= limit {
        return;
    }
    // A scope is the container (or the whole engine) and whose points it masks.
    let mut spans: BTreeMap<_, (i64, i64, String)> = BTreeMap::new();
    gaps.retain(|g| {
        let (Some(end), true) = (g.end_ms, masking(g)) else {
            return true;
        };
        let span = spans
            .entry((g.container_id.clone(), g.masking()))
            .or_insert((g.start_ms, end, g.reason().to_owned()));
        span.0 = span.0.min(g.start_ms);
        span.1 = span.1.max(end);
        false
    });
    gaps.extend(
        spans
            .into_iter()
            .map(|((container, masking), (start, end, reason))| {
                let unknown = api::DockerCoverage::new(
                    start,
                    Some(end),
                    container.clone(),
                    "coverage_unknown".into(),
                );
                // Engine-wide, `coverage_unknown` also masks the aggregate. A scope it
                // would widen (a failed inventory) keeps its own reason.
                if unknown.masking() == masking {
                    unknown
                } else {
                    api::DockerCoverage::new(start, Some(end), container, reason)
                }
            }),
    );
}
fn retry_bytes(retry: &Retry) -> usize {
    retry
        .events
        .iter()
        .map(|e| {
            e.action.len()
                + e.entity.as_ref().map_or(0, String::len)
                + e.attributes
                    .iter()
                    .map(|(k, v)| k.len() + v.len() + 64)
                    .sum::<usize>()
                + 256
        })
        .sum::<usize>()
        + retry
            .coverage
            .iter()
            .map(|c| c.entity.as_ref().map_or(0, String::len) + c.reason.len() + 256)
            .sum::<usize>()
        + retry
            .entities
            .iter()
            .map(|e| e.extras.len() + e.name.len() + e.image.len() + 512)
            .sum::<usize>()
        + retry.cursor.as_ref().map_or(0, |c| c.event_key.len() + 64)
}
pub(super) fn recount_aux(s: &mut State) {
    let mut read_payload = 0;
    s.shared_read_buckets.retain(|address, read| {
        let in_ring = s
            .entries
            .get(&read.key)
            .is_some_and(|entry| Arc::as_ptr(&entry.bucket) as usize == *address);
        if read.bucket.strong_count() <= usize::from(in_ring) {
            return false;
        }
        // The map and its identity strings are owned even while payload is shared.
        read_payload += 192 + read.key.0.len() + read.key.1.len();
        if !in_ring {
            read_payload += read.bytes;
        }
        true
    });
    // Conservative owned-memory allowance: strings/serialized extras + map/allocator
    // overhead, including duplicate latest facts and fingerprints.
    s.aux_bytes = read_payload
        + s.facts
            .values()
            .map(|e| e.extras.len() * 3 + e.name.len() + e.image.len() + 512)
            .sum::<usize>()
        + s.metadata_history
            .iter()
            .map(|(_, e)| e.extras.len() + 512)
            .sum::<usize>()
        + s.fingerprints
            .values()
            .map(|v| v.len() + 256)
            .sum::<usize>()
        + s.events
            .iter()
            .map(|e| {
                e.id.len()
                    + e.time_ns.len()
                    + e.action.len()
                    + e.name.as_ref().map_or(0, String::len)
                    + e.attributes
                        .iter()
                        .map(|(k, v)| k.len() + v.len() + 64)
                        .sum::<usize>()
                    + 512
            })
            .sum::<usize>()
        + s.population_facts
            .values()
            .map(|p| p.members.iter().map(|id| id.len() + 64).sum::<usize>() + 128)
            .sum::<usize>()
        + s.pending
            .iter()
            .map(|p| {
                retry_bytes(&p.retry)
                    + p.keys
                        .iter()
                        .map(|(a, b, _)| a.len() + b.len() + 128)
                        .sum::<usize>()
                    + 256
            })
            .sum::<usize>()
        + s.retry.values().map(retry_bytes).sum::<usize>()
        + s.last_warning.len() * 384
        + s.observed.len() * 384
        + s.runtime.len() * 512
        + (s.restored_coverage.len() + s.restore_retry.len()) * 320
        + s.coverage.values().map(|g| g.len() * 512).sum::<usize>()
        + s.saved_coverage
            .values()
            .map(|k| k.len() * 256)
            .sum::<usize>();
}
/// Unpinned entries past their retention. A persisted bucket is on disk, where every
/// reader also looks: it stays only until no late observation can reach it (spans are
/// capped at 60 s). Unpersisted ones stay the hour.
fn expired(s: &State, now: i64) -> Vec<Key> {
    s.entries
        .iter()
        .filter(|((_, _, t), e)| {
            let end = t.saturating_add(DOCKER_BUCKET_MS);
            let persisted = e.bucket.revision <= e.durable;
            e.pins == 0 && (end <= now - HOUR || persisted && end <= now - PERSISTED_KEEP_MS)
        })
        .map(|(k, _)| k.clone())
        .collect()
}
/// Closed coverage leaves memory with the ring's hour; the store keeps its copy. What
/// the store saved matters only while memory holds the record.
fn evict_coverage(s: &mut State, now: i64) {
    for gaps in s.coverage.values_mut() {
        gaps.retain(|g| g.end_ms.is_none_or(|end| end >= now - HOUR));
    }
    for (engine, saved) in &mut s.saved_coverage {
        let held: BTreeSet<_> = s
            .coverage
            .get(engine)
            .into_iter()
            .flatten()
            .filter_map(coverage_key)
            .collect();
        saved.retain(|key| held.contains(key));
    }
    s.saved_coverage.retain(|_, saved| !saved.is_empty());
}
pub(super) fn evict(s: &mut State, now: i64) {
    for key in expired(s, now) {
        evict_entry(s, &key);
    }
    s.events.retain(|e| e.time_ms >= now - HOUR);
    evict_coverage(s, now);
    let active: BTreeSet<_> = s
        .entries
        .keys()
        .map(|(engine, id, _)| (engine.clone(), id.clone()))
        .collect();
    s.metadata
        .retain(|key, c| c.last_seen_ms >= now - HOUR || active.contains(key));
    s.facts
        .retain(|key, _| s.metadata.contains_key(key) || key.1.is_empty() && active.contains(key));
    s.fingerprints.retain(|key, _| s.metadata.contains_key(key));
    s.observed
        .retain(|key, t| *t >= now - HOUR || active.contains(key));
    // Keep one predecessor per entity for an hour's buckets.
    let mut newest_old = BTreeMap::new();
    for (engine, e) in &s.metadata_history {
        if e.effective_ms < now - HOUR {
            newest_old.insert(
                (engine.clone(), e.external_id.clone()),
                (e.effective_ms, e.revision),
            );
        }
    }
    s.metadata_history.retain(|(engine, e)| {
        e.effective_ms >= now - HOUR
            || newest_old.get(&(engine.clone(), e.external_id.clone()))
                == Some(&(e.effective_ms, e.revision))
                && active.contains(&(engine.clone(), e.external_id.clone()))
    });
    let needed: BTreeSet<_> = s
        .entries
        .iter()
        .flat_map(|((engine, _, _), e)| {
            e.bucket
                .populations
                .iter()
                .map(|p| (engine.clone(), p.revision))
        })
        .collect();
    s.population_facts.retain(|key, _| {
        needed.contains(key) || s.populations.get(&key.0).is_some_and(|(r, _)| *r == key.1)
    });
    let engines: BTreeSet<_> = s
        .entries
        .keys()
        .map(|(e, _, _)| e.clone())
        .chain(s.metadata.keys().map(|(e, _)| e.clone()))
        .collect();
    s.populations.retain(|e, _| engines.contains(e));
    s.runtime.retain(|e, _| engines.contains(e));
    s.last_warning
        .retain(|e, _| engines.contains(e) || s.retry.contains_key(e));
    s.coverage.retain(|e, _| engines.contains(e));
    // Restore runs once per daemon and attach, never again for a daemon that left
    // memory: its open rows are this process's own by then (`first_observed`).
    s.restore_retry.retain(|e, _| engines.contains(e));
    recount_aux(s);
    while s.bytes + s.aux_bytes + s.reader_bytes > RING_BYTES {
        if let Some(key) = s
            .entries
            .iter()
            .filter(|(_, e)| e.pins == 0)
            .min_by_key(|((_, _, t), _)| *t)
            .map(|(key, _)| key.clone())
        {
            evict_entry(s, &key);
            recount_aux(s);
            continue;
        }
        if s.metadata_history.pop_front().is_some() {
            recount_aux(s);
            continue;
        }
        if let Some(key) = s
            .metadata
            .iter()
            .min_by_key(|(_, c)| c.last_seen_ms)
            .map(|(k, _)| k.clone())
        {
            s.metadata.remove(&key);
            s.facts.remove(&key);
            s.observed.remove(&key);
            s.fingerprints.remove(&key);
            recount_aux(s);
            continue;
        }
        if s.events.pop_front().is_some() {
            recount_aux(s);
            continue;
        }
        break;
    }
}
