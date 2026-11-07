//! Coverage for one read: the recorder's live records (memory, writes in flight and
//! retries) merged with the store's streamed rows, folded into each point's masked time
//! and a bounded list (D-128). No read fails because a scope has many records.
use super::projection::Mask;
use super::*;

/// A record's identity: container, reason and start.
type RecordKey = (Option<String>, String, i64);
fn key(c: &api::DockerCoverage) -> RecordKey {
    (c.container_id.clone(), c.reason().to_owned(), c.start_ms)
}
fn record(row: db::DockerCoverage) -> api::DockerCoverage {
    api::DockerCoverage::new(row.start_ms, row.end_ms, row.entity, row.reason)
}
/// Two copies of one record: a closed copy wins, then the later end.
fn merged_end(a: Option<i64>, b: Option<i64>) -> Option<i64> {
    a.max(b)
}
fn overlaps(c: &api::DockerCoverage, from: i64, to: i64) -> bool {
    c.start_ms < to && c.end_ms.is_none_or(|end| end > from)
}

/// The engine's records this recorder holds: its in-memory list, then the rows of
/// writes in flight and of retries that memory no longer lists (`bound_coverage`
/// drops those). Writer admission bounds both.
pub(super) fn live_coverage(s: &State, engine: &str) -> Vec<api::DockerCoverage> {
    let mut out: Vec<api::DockerCoverage> = s.coverage.get(engine).cloned().unwrap_or_default();
    let mut index: BTreeMap<RecordKey, usize> =
        out.iter().enumerate().map(|(i, c)| (key(c), i)).collect();
    let written = s
        .pending
        .iter()
        .filter(|p| p.engine == engine)
        .flat_map(|p| &p.retry.coverage)
        .chain(s.retry.get(engine).into_iter().flat_map(|r| &r.coverage))
        .filter(|row| row.metric.is_none());
    for row in written {
        let c = record(row.clone());
        match index.get(&key(&c)).and_then(|i| out.get_mut(*i)) {
            Some(old) => old.end_ms = merged_end(old.end_ms, c.end_ms),
            None => {
                index.insert(key(&c), out.len());
                out.push(c);
            }
        }
    }
    out
}
/// Closed records in writes in flight or retries: the store will hold them, or the
/// retry does, so memory need not (`bound_coverage`).
pub(super) fn written_coverage(s: &State, engine: &str) -> BTreeSet<CoverageKey> {
    s.pending
        .iter()
        .filter(|p| p.engine == engine)
        .flat_map(|p| &p.retry.coverage)
        .chain(s.retry.get(engine).into_iter().flat_map(|r| &r.coverage))
        .filter_map(|c| {
            c.end_ms
                .map(|end| (c.entity.clone(), c.reason.clone(), c.start_ms, end))
        })
        .collect()
}

/// The newest records of one scope, at most `MAX_COVERAGE_LISTED`, and how many there
/// were. Rows arrive in start order, so the front is the oldest. A read masks from its
/// first bucket's start, which can be before the range: a record that ends by `from`
/// masks points but is neither listed nor counted.
struct Listed {
    records: VecDeque<api::DockerCoverage>,
    total: usize,
    from: i64,
}
impl Listed {
    fn new(from: i64) -> Self {
        Self {
            records: VecDeque::new(),
            total: 0,
            from,
        }
    }
    fn push(&mut self, c: api::DockerCoverage) {
        if c.end_ms.is_some_and(|end| end <= self.from) {
            return;
        }
        self.total += 1;
        self.records.push_back(c);
        if self.records.len() > api::MAX_COVERAGE_LISTED {
            self.records.pop_front();
        }
    }
    /// Adds the live records the store did not hold and keeps the newest.
    fn finish(
        self,
        live: impl Iterator<Item = api::DockerCoverage>,
    ) -> (Vec<api::DockerCoverage>, usize) {
        let mut total = self.total;
        let from = self.from;
        let mut records: Vec<_> = self.records.into();
        for c in live.filter(|c| c.end_ms.is_none_or(|end| end > from)) {
            total += 1;
            records.push(c);
        }
        records.sort_by(|a, b| {
            (a.start_ms, &a.container_id, a.reason()).cmp(&(
                b.start_ms,
                &b.container_id,
                b.reason(),
            ))
        });
        let excess = records.len().saturating_sub(api::MAX_COVERAGE_LISTED);
        records.drain(..excess);
        (records, total)
    }
}

/// Engine-wide coverage for a read, read once however many points or candidates it
/// masks: a bounded list and the disjoint spans that mask containers and the aggregate.
pub(super) struct EngineCoverage {
    pub(super) listed: Vec<api::DockerCoverage>,
    pub(super) total: usize,
    /// Where the range starts: records that end by it mask points but are not listed.
    listed_from: i64,
    containers: Vec<(i64, i64)>,
    aggregate: Vec<(i64, i64)>,
}
impl EngineCoverage {
    pub(super) fn read(
        snapshot: Option<&db::DockerReadSnapshot<'_>>,
        live: &[api::DockerCoverage],
        (from, to): (i64, i64),
        listed_from: i64,
    ) -> Result<Self, DockerServiceError> {
        let mut live: Vec<_> = live
            .iter()
            .filter(|c| c.container_id.is_none() && overlaps(c, from, to))
            .cloned()
            .collect();
        let index: BTreeMap<_, _> = live.iter().enumerate().map(|(i, c)| (key(c), i)).collect();
        let mut listed = Listed::new(listed_from);
        let mut containers = Vec::new();
        let mut aggregate = Vec::new();
        if let Some(snapshot) = snapshot {
            snapshot.engine_coverage(from, to, |row| {
                let c = record(row);
                if let Some(old) = index.get(&key(&c)).and_then(|i| live.get_mut(*i)) {
                    old.end_ms = merged_end(old.end_ms, c.end_ms);
                    return Ok(());
                }
                spans_push(&mut containers, &mut aggregate, &c, to);
                listed.push(c);
                Ok(())
            })?;
        }
        for c in &live {
            spans_push(&mut containers, &mut aggregate, c, to);
        }
        let (listed, total) = listed.finish(live.into_iter());
        Ok(Self {
            listed,
            total,
            containers: union(containers),
            aggregate: union(aggregate),
            listed_from,
        })
    }
    fn spans(&self, container: Option<&str>) -> &[(i64, i64)] {
        if container.is_some() {
            &self.containers
        } else {
            &self.aggregate
        }
    }
}
fn spans_push(
    containers: &mut Vec<(i64, i64)>,
    aggregate: &mut Vec<(i64, i64)>,
    c: &api::DockerCoverage,
    to: i64,
) {
    let span = (c.start_ms, c.end_ms.unwrap_or(to));
    if c.masks(Some("")) {
        extend_union(containers, span);
    }
    if c.masks(None) {
        extend_union(aggregate, span);
    }
}
/// Appends a span that starts no earlier than the last, merging when they touch.
/// Out-of-order spans (live records) are merged by `union` at the end.
fn extend_union(spans: &mut Vec<(i64, i64)>, (start, end): (i64, i64)) {
    match spans.last_mut() {
        Some(last) if last.0 <= start && last.1 >= start => last.1 = last.1.max(end),
        _ => spans.push((start, end)),
    }
}
fn union(mut spans: Vec<(i64, i64)>) -> Vec<(i64, i64)> {
    spans.sort_unstable();
    let mut out: Vec<(i64, i64)> = Vec::with_capacity(spans.len());
    for span in spans {
        extend_union(&mut out, span);
    }
    out
}

/// Masks `points` of `entity` (a container, or `""` for the aggregate) by the engine's
/// spans and the entity's own records, streamed from the store in start order and
/// merged with the live ones, and returns the entity's bounded list and total.
pub(super) fn mask_entity(
    snapshot: Option<&db::DockerReadSnapshot<'_>>,
    live: &[api::DockerCoverage],
    engine: &EngineCoverage,
    entity: &str,
    container: Option<&str>,
    (from, to): (i64, i64),
    points: &mut [api::DockerHistoryPoint],
) -> Result<(Vec<api::DockerCoverage>, usize), DockerServiceError> {
    let live: Vec<_> = live
        .iter()
        .filter(|c| c.container_id.as_deref() == Some(entity) && overlaps(c, from, to))
        .cloned()
        .collect();
    let index: BTreeMap<_, _> = live.iter().enumerate().map(|(i, c)| (key(c), i)).collect();
    let mut consumed = vec![false; live.len()];
    // Engine spans and live masking records, in start order; a live record's index
    // lets its store copy replace it.
    let mut pending: Vec<(i64, i64, Option<usize>)> = engine
        .spans(container)
        .iter()
        .map(|&(s, e)| (s, e, None))
        .chain(
            live.iter()
                .enumerate()
                .filter(|(_, c)| c.masks(container))
                .map(|(i, c)| (c.start_ms, c.end_ms.unwrap_or(to), Some(i))),
        )
        .collect();
    pending.sort_unstable_by_key(|(s, _, _)| *s);
    let mut pending = pending.into_iter().peekable();
    let mut mask = Mask::new(points);
    let mut listed = Listed::new(engine.listed_from);
    let mut drain = |mask: &mut Mask, consumed: &[bool], before: Option<i64>| {
        while let Some(&(s, e, i)) = pending.peek() {
            if before.is_some_and(|before| s >= before) {
                break;
            }
            pending.next();
            if i.is_none_or(|i| !consumed.get(i).copied().unwrap_or(false)) {
                mask.add(s, e);
            }
        }
    };
    if let Some(snapshot) = snapshot {
        snapshot.entity_coverage(entity, from, to, |row| {
            let mut c = record(row);
            if let Some(&i) = index.get(&key(&c))
                && let (Some(flag), Some(old)) = (consumed.get_mut(i), live.get(i))
            {
                *flag = true;
                c.end_ms = merged_end(c.end_ms, old.end_ms);
            }
            drain(&mut mask, &consumed, Some(c.start_ms));
            if c.masks(container) {
                mask.add(c.start_ms, c.end_ms.unwrap_or(to));
            }
            listed.push(c);
            Ok(())
        })?;
    }
    drain(&mut mask, &consumed, None);
    mask.apply(points);
    let unread = live
        .into_iter()
        .zip(consumed)
        .filter_map(|(c, consumed)| (!consumed).then_some(c));
    Ok(listed.finish(unread))
}
