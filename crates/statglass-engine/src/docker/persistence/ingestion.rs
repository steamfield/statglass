//! Admit observations and lifecycle evidence under the recorder coordination lock.
use super::*;

impl DockerRecorder {
    pub fn record(&self, snapshot: &api::DockerSnapshot) {
        let Some(engine) = &snapshot.engine else {
            return;
        };
        let Some(daemon) = &engine.daemon_id else {
            return;
        };
        let (attached, coord) = self.context();
        let _guard = coord.lock_ok();
        let mut s = self.state.lock_ok();
        if s.suspended || snapshot.generation < s.generation_floor {
            return;
        }
        drain(&mut s);
        s.generation = snapshot.generation;
        s.runtime.insert(daemon.clone(), engine.runtime.clone());
        let now = snapshot.observed_ms;
        s.first_observed.entry(daemon.clone()).or_insert(now);
        evict(&mut s, now);
        let stale = self.restore_coverage(&mut s, attached.as_ref(), daemon, now);
        let mut batch = self.batch(&mut s, daemon, snapshot.generation, now);
        for gap in stale {
            push_coverage(&mut s, &mut batch, &gap, now);
        }
        record_capacity(&mut s, &mut batch, engine, daemon, now);
        let population = record_population(&mut s, snapshot, daemon, now);
        record_containers(&mut s, &mut batch, snapshot, daemon);
        record_aggregate(&mut s, snapshot, daemon, population, now);
        record_coverage(&mut s, &mut batch, snapshot, daemon, now);
        let keys = pending_buckets(&s, &mut batch, daemon, now);
        recount_aux(&mut s);
        evict(&mut s, now);
        batch.revision = s.revision;
        batch.start_ms = batch
            .buckets
            .iter()
            .map(|b| b.bucket_ms)
            .min()
            .unwrap_or(now);
        queue(&mut s, attached.as_ref(), batch, keys);
    }
    pub fn clock_step(&self, from_ms: i64) {
        let (a, coord) = self.context();
        let _g = coord.lock_ok();
        let mut s = self.state.lock_ok();
        // Observations before the step stay deduplicated; ones the old clock dated
        // after it must not hide the real observations that follow.
        for time in s.observed.values_mut() {
            *time = (*time).min(from_ms - 1);
        }
        let remove: Vec<_> = s
            .entries
            .keys()
            .filter(|(_, _, t)| *t + DOCKER_BUCKET_MS > from_ms)
            .cloned()
            .collect();
        for key in remove {
            if let Some(e) = s.entries.remove(&key) {
                s.bytes = s.bytes.saturating_sub(e.bytes);
            }
        }
        s.metadata_history.retain(|(_, e)| e.effective_ms < from_ms);
        s.facts.clear();
        for (engine, fact) in s.metadata_history.clone() {
            s.facts.insert((engine, fact.external_id.clone()), fact);
        }
        // Reseed current observations at their new wall time, even when values did
        // not change. A future fingerprint must never suppress its replacement.
        s.fingerprints.clear();
        s.metadata.clear();
        s.populations.clear();
        s.population_facts.retain(|_, p| p.effective_ms < from_ms);
        for gaps in s.coverage.values_mut() {
            gaps.retain(|g| g.start_ms < from_ms);
            for gap in gaps {
                if gap.end_ms.is_none_or(|end| end > from_ms) {
                    gap.end_ms = Some(from_ms);
                }
            }
        }
        // Writes not yet saved forget the same span, so a retry never re-extends a
        // record past the step or resaves what the store discards.
        let state = &mut *s;
        for retry in state
            .retry
            .values_mut()
            .chain(state.pending.iter_mut().map(|p| &mut p.retry))
        {
            step_retry(retry, from_ms);
        }
        recount_aux(&mut s);
        s.events.retain(|e| e.time_ms < from_ms);
        s.reset_epoch = s.reset_epoch.wrapping_add(1);
        if let Some(a) = a
            && let Err(e) = a.writer.discard_from_soon(self.host, from_ms)
        {
            s.error = Some(e.to_string());
        }
    }
    pub fn removed(&self, c: &api::DockerContainer, generation: u32) {
        let (a, coord) = self.context();
        let _g = coord.lock_ok();
        let mut s = self.state.lock_ok();
        if s.suspended || generation < s.generation_floor {
            return;
        }
        let mut batch = self.batch(&mut s, &c.engine_id, generation, c.last_seen_ms);
        metadata(&mut s, &mut batch, &c.engine_id, c);
        batch.revision = s.revision;
        queue(&mut s, a.as_ref(), batch, Vec::new());
    }
    pub fn event(&self, event: &api::DockerEvent, generation: u32) {
        let (a, coord) = self.context();
        let _g = coord.lock_ok();
        let mut s = self.state.lock_ok();
        drain(&mut s);
        if s.suspended || generation < s.generation_floor {
            return;
        }
        if s.events.iter().any(|e| e.id == event.id) {
            return;
        }
        let attributes = event.attributes.clone();
        let Ok(time_ns) = event.time_ns.parse() else {
            return;
        };
        let e = db::DockerEvent {
            entity: event.container_id.clone(),
            time_ns,
            action: event.action.clone(),
            attributes,
        };
        let Ok(key) = e.key(&event.engine_id) else {
            return;
        };
        let mut event = event.clone();
        event.id = key.clone();
        s.events.push_back(event.clone());
        while s.events.len() > 4096 {
            s.events.pop_front();
        }
        recount_aux(&mut s);
        evict(&mut s, event.time_ms);
        let mut batch = self.batch(&mut s, &event.engine_id, generation, event.time_ms);
        if !s.retry.contains_key(&event.engine_id) {
            batch.cursor = Some(db::DockerCursor {
                time_ns,
                event_key: key,
            });
        }
        if let Some(id) = &event.container_id
            && let Some(fact) = s.facts.get(&(event.engine_id.clone(), id.clone()))
        {
            batch.entities.push(fact.clone());
        }
        batch.events.push(e);
        queue(&mut s, a.as_ref(), batch, Vec::new());
    }
}

/// A retry after a clock step to `from_ms`: rows and events from the step on are gone,
/// and every other row ends by it.
fn step_retry(retry: &mut Retry, from_ms: i64) {
    retry.coverage.retain(|c| c.start_ms < from_ms);
    for c in &mut retry.coverage {
        if c.end_ms.is_none_or(|end| end > from_ms) {
            c.end_ms = Some(from_ms);
            c.expected_ms = from_ms - c.start_ms;
            c.sampled_ms = c.sampled_ms.min(c.expected_ms);
        }
    }
    retry.events.retain(|e| e.time_ns / 1_000_000 < from_ms);
    if retry
        .cursor
        .as_ref()
        .is_some_and(|c| c.time_ns / 1_000_000 >= from_ms)
    {
        retry.cursor = None;
    }
}

impl DockerRecorder {
    /// Returns the stale records it closed, for the caller to persist.
    fn restore_coverage(
        &self,
        s: &mut State,
        attached: Option<&Attached>,
        daemon: &str,
        now: i64,
    ) -> Vec<api::DockerCoverage> {
        // A new process has no published coverage from the previous process.
        // Restore its open lifecycle intervals before the first observation so
        // the ring can close them immediately, ahead of SQLite's commit cadence.
        let mut closed = Vec::new();
        if !s.restored_coverage.contains(daemon)
            && let Some(attached) = attached
            && s.restore_retry
                .get(daemon)
                .is_none_or(|(at, _)| Instant::now() >= *at)
        {
            let restored = (|| -> Result<_, statglass_store::StoreError> {
                let mut reader = Reader::open(&attached.path)?;
                let snapshot = reader.docker_snapshot(self.host, daemon)?;
                Ok((snapshot.open_coverage()?, snapshot.last_observed()?))
            })();
            let first_observed = s.first_observed.get(daemon).copied();
            match restored {
                Ok((gaps, last_observed)) => {
                    s.restore_retry.remove(daemon);
                    let coverage = s.coverage.entry(daemon.to_owned()).or_default();
                    for gap in gaps {
                        if coverage.iter().any(|g| {
                            g.start_ms == gap.start_ms
                                && g.container_id == gap.entity
                                && g.reason() == gap.reason
                        }) {
                            continue;
                        }
                        if db::resumes_on_observation(&gap.reason) && gap.entity.is_none() {
                            coverage.push(api::DockerCoverage::new(
                                gap.start_ms,
                                None,
                                None,
                                gap.reason,
                            ));
                        } else {
                            // No observation resumes this record and the process that
                            // opened it stopped without closing it (a crash): it ends
                            // where that process's observations do, never in the future
                            // and never after this process's first observation: a late
                            // restore reads this process's own saved time too.
                            let first = first_observed.unwrap_or(now);
                            let end = last_observed
                                .unwrap_or(gap.start_ms)
                                .min(now)
                                .min(first)
                                .max(gap.start_ms);
                            let record = api::DockerCoverage::new(
                                gap.start_ms,
                                Some(end),
                                gap.entity,
                                gap.reason,
                            );
                            coverage.push(record.clone());
                            closed.push(record);
                        }
                    }
                    s.restored_coverage.insert(daemon.to_owned());
                }
                Err(error) => {
                    // Retry on a doubling backoff, or at once on the next attach.
                    let backoff = s
                        .restore_retry
                        .get(daemon)
                        .map_or(RESTORE_RETRY_MIN, |(_, d)| (*d * 2).min(RESTORE_RETRY_MAX));
                    s.restore_retry
                        .insert(daemon.to_owned(), (Instant::now() + backoff, backoff));
                    // Not a saving failure: recording continues. The backoff bounds this
                    // to one line per retry.
                    tracing::warn!(%daemon, %error, ?backoff, "Docker coverage restore failed; will retry");
                }
            }
        }
        closed
    }
}

fn record_capacity(
    s: &mut State,
    batch: &mut db::DockerBatch,
    engine: &api::DockerEngine,
    daemon: &str,
    now: i64,
) {
    let capacity = engine
        .capacity_bytes
        .filter(|v| v.is_finite() && *v >= 0.)
        .map(|v| v as i64);
    if s.facts
        .get(&(daemon.to_owned(), String::new()))
        .is_none_or(|e| e.capacity != capacity)
    {
        let fact = db::DockerEntity {
            external_id: String::new(),
            effective_ms: engine.capacity_observed_ms.unwrap_or(now).min(now),
            revision: next(s),
            name: engine.runtime.clone(),
            capacity,
            last_seen_ms: now,
            ..Default::default()
        };
        s.facts
            .insert((daemon.to_owned(), String::new()), fact.clone());
        s.metadata_history
            .push_back((daemon.to_owned(), fact.clone()));
        batch.entities.push(fact);
    }
}

fn record_population(s: &mut State, snapshot: &api::DockerSnapshot, daemon: &str, now: i64) -> i64 {
    let members: Vec<_> = snapshot
        .containers
        .iter()
        .filter(|c| c.monitored)
        .map(|c| c.id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    if s.populations
        .get(daemon)
        .is_none_or(|(_, old)| *old != members)
    {
        let revision = next(s);
        s.populations.insert(daemon.to_owned(), (revision, members));
    }
    let (population, members) = s.populations.get(daemon).cloned().unwrap_or_default();
    let fact = db::DockerPopulation {
        revision: population,
        effective_ms: now,
        members,
    };
    s.population_facts
        .entry((daemon.to_owned(), population))
        .or_insert(fact);
    population
}

fn record_containers(
    s: &mut State,
    batch: &mut db::DockerBatch,
    snapshot: &api::DockerSnapshot,
    daemon: &str,
) {
    for c in &snapshot.containers {
        metadata(s, batch, daemon, c);
        if !c.monitored {
            continue;
        }
        let Some(time) = c.observed_ms else {
            continue;
        };
        // A first sample has no counter baseline, so no CPU or rates; its gauges
        // (memory) stand for the publish interval like any other observation.
        let span = match c.interval_ms {
            Some(0) => snapshot.interval_ms,
            interval => interval.unwrap_or(0),
        }
        .min(60_000) as i64;
        if span == 0
            || s.observed
                .get(&(daemon.to_owned(), c.id.clone()))
                .is_some_and(|v| *v >= time)
        {
            continue;
        }
        s.observed.insert((daemon.to_owned(), c.id.clone()), time);
        observe(s, daemon, &c.id, time, span, &c.metrics, None);
    }
}

fn record_aggregate(
    s: &mut State,
    snapshot: &api::DockerSnapshot,
    daemon: &str,
    population: i64,
    now: i64,
) {
    if !s
        .observed
        .get(&(daemon.to_owned(), String::new()))
        .is_some_and(|v| *v >= now)
    {
        s.observed.insert((daemon.to_owned(), String::new()), now);
        let metrics = api::DockerMetrics {
            cpu_pct: snapshot.aggregate.cpu_cores.map(|v| v * 100.),
            working_set_bytes: snapshot.aggregate.working_set_bytes,
            ..Default::default()
        };
        observe(
            s,
            daemon,
            "",
            now,
            snapshot.interval_ms.min(60_000) as i64,
            &metrics,
            Some((
                population,
                snapshot.aggregate.cpu_measured == snapshot.aggregate.expected,
                snapshot.aggregate.memory_measured == snapshot.aggregate.expected,
            )),
        );
    }
}

fn record_coverage(
    s: &mut State,
    batch: &mut db::DockerBatch,
    snapshot: &api::DockerSnapshot,
    daemon: &str,
    now: i64,
) {
    // configure() clears the published generation's coverage. The recorder
    // still owns the old engine interruption until that daemon resumes.
    let mut resumed = Vec::new();
    if snapshot.status == api::DockerStatus::Connected
        && let Some(gaps) = s.coverage.get_mut(daemon)
    {
        for gap in gaps.iter_mut().filter(|g| {
            db::resumes_on_observation(g.reason()) && g.end_ms.is_none() && g.start_ms < now
        }) {
            gap.end_ms = Some(now);
            resumed.push(gap.clone());
        }
    }
    for gap in resumed {
        push_coverage(s, batch, &gap, now);
    }
    // Closed records past the hour have left memory (evict) and are already saved;
    // admitting them again would rewrite them on every cycle.
    let current: Vec<_> = snapshot
        .coverage
        .iter()
        .filter(|c| c.end_ms.is_none_or(|end| end >= now - HOUR))
        .collect();
    let mut changed = Vec::new();
    // Only a record memory does not list needs the held set; recording adds nothing to
    // it (the batch is not queued yet), so bounding reuses it.
    let unlisted = current.iter().any(|c| {
        s.coverage
            .get(daemon)
            .is_none_or(|gaps| !gaps.iter().any(|old| same_record(old, c)))
    });
    let held = unlisted.then(|| held_coverage(s, daemon));
    let gaps = s.coverage.entry(daemon.to_owned()).or_default();
    for c in current {
        // It is saved again only when it is new or this snapshot moves its end; an
        // open copy never reopens a record the recorder closed (a clock step closes
        // them first).
        match gaps.iter_mut().find(|old| same_record(old, c)) {
            Some(old) if old.end_ms == c.end_ms || c.end_ms.is_none() => {}
            Some(old) => {
                *old = c.clone();
                changed.push(c.clone());
            }
            // Memory let it go because the store or a write holds it already.
            None if coverage_key(c)
                .is_some_and(|key| held.as_ref().is_some_and(|held| held.contains(&key))) => {}
            None => {
                gaps.push(c.clone());
                changed.push(c.clone());
            }
        }
    }
    for c in &changed {
        push_coverage(s, batch, c, now);
    }
    bound_engine_coverage(s, daemon, held);
}

fn push_coverage(s: &mut State, batch: &mut db::DockerBatch, c: &api::DockerCoverage, now: i64) {
    let row = coverage_row(s, c, now);
    batch.coverage.push(row);
}

fn pending_buckets(s: &State, batch: &mut db::DockerBatch, daemon: &str, now: i64) -> Vec<Key> {
    let cut = floor_to(now, DOCKER_BUCKET_MS);
    let keys: Vec<_> = s
        .entries
        .iter()
        .filter(|((e, _, t), v)| {
            e == daemon && *t < cut && v.pins == 0 && v.bucket.revision > v.durable
        })
        .take(1024)
        .map(|(k, _)| k.clone())
        .collect();
    for key in &keys {
        if let Some(e) = s.entries.get(key) {
            batch.buckets.push((*e.bucket).clone());
        }
    }
    let needed: BTreeSet<_> = batch
        .buckets
        .iter()
        .flat_map(|b| b.populations.iter().map(|p| p.revision))
        .collect();
    batch.populations = needed
        .into_iter()
        .filter_map(|revision| {
            s.population_facts
                .get(&(daemon.to_owned(), revision))
                .cloned()
        })
        .collect();
    let needed: BTreeSet<_> = batch.buckets.iter().map(|b| b.entity.clone()).collect();
    for id in needed {
        if !batch.entities.iter().any(|e| e.external_id == id)
            && let Some(fact) = s.facts.get(&(daemon.to_owned(), id))
        {
            batch.entities.push(fact.clone());
        }
    }
    keys
}
