//! Tier selection and captured history reads.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;

use rusqlite::params;
use statglass_schema::{Gap, HostId, SeriesKey, SeriesSelector, Tier, floor_to};

use super::{HistoryBucketRow, Merge, Positions, Reader, f32_at};
use crate::db::{self, tier_width};
use crate::error::{Result, StoreError};
use crate::types::{BucketRow, HistoryQuery, HistoryResult, Retention, TierChoice, TierCoverage};

impl Reader {
    /// Keeps metadata and rows on one SQLite read snapshot, including when the writer
    /// publishes a new layout. A caller that already owns a transaction keeps it.
    pub fn with_history_snapshot<T>(
        &mut self,
        read: impl FnOnce(&mut Self) -> Result<T>,
    ) -> Result<T> {
        if self.in_transaction() {
            return read(self);
        }
        self.conn.execute_batch("BEGIN DEFERRED")?;
        let result = read(self);
        let end = self.conn.execute_batch("ROLLBACK");
        let value = result?;
        end?;
        Ok(value)
    }

    /// Captures source rows once. The caller can merge those same rows at another
    /// point budget without moving the range, fetching new data, or weighting slots.
    pub fn history_snapshot<R: AsRef<[BucketRow]>>(
        &mut self,
        q: &HistoryQuery,
        max_series: Option<usize>,
        recent: impl FnOnce() -> R,
    ) -> Result<HistorySnapshot<R>> {
        self.with_history_snapshot(|reader| {
            let host = reader.host_ref(q.host)?;
            let tier = reader.resolve_tier(host, q.from_ms, q.to_ms, q.tier)?;
            let width = tier_width(tier)?;
            let gaps = reader.gaps_in(host, q.from_ms, q.to_ms)?;
            let mut snapshot = HistorySnapshot {
                query: q.clone(),
                tier,
                width,
                gaps,
                layouts: BTreeMap::new(),
                rows: Vec::new(),
                recent: None,
                selection: max_series.map(HistorySelection::new),
            };
            if q.to_ms <= q.from_ms || q.selectors.is_empty() {
                return Ok(snapshot);
            }
            let base = floor_to(q.from_ms, width);
            snapshot.layouts = reader.history_layouts(host, tier, base, q.to_ms, &q.selectors)?;
            if let Some(selection) = &mut snapshot.selection {
                for layout in snapshot.layouts.values() {
                    selection.add(layout, &q.selectors, true);
                }
                snapshot
                    .layouts
                    .retain(|_, layout| layout.iter().any(|key| selection.keys.contains(key)));
            }
            let ids = snapshot.layouts.keys().copied().collect::<Vec<_>>();
            snapshot.rows = reader.history_bucket_rows(host, tier, base, q.to_ms, &ids)?;
            #[cfg(test)]
            {
                reader.history_rows_read = snapshot.rows.len();
            }
            let recent = recent();
            if let Some(selection) = &mut snapshot.selection {
                for row in recent
                    .as_ref()
                    .iter()
                    .filter(|row| in_recent_range(row, tier, base, q.to_ms))
                {
                    selection.add(&row.series, &q.selectors, false);
                }
            }
            snapshot.recent = Some(recent);
            Ok(snapshot)
        })
    }

    fn history_layouts(
        &mut self,
        host: i64,
        tier: Tier,
        from: i64,
        to: i64,
        selectors: &[SeriesSelector],
    ) -> Result<BTreeMap<u32, Arc<[SeriesKey]>>> {
        // Discover active IDs from the covering tier index, without fetching any blobs.
        let mut ids = BTreeSet::new();
        for (table, _) in db::bucket_sources(tier)? {
            let sql = format!(
                "SELECT DISTINCT layout_id FROM {table}
                 WHERE host_id = ?1 AND bucket_ts >= ?2 AND bucket_ts < ?3"
            );
            let mut stmt = self.conn.prepare_cached(&sql)?;
            for id in stmt.query_map(params![host, from, to], |row| row.get(0))? {
                ids.insert(id?);
            }
        }
        let mut layouts = BTreeMap::new();
        for id in ids {
            let keys = self.layout(id)?;
            if keys
                .iter()
                .any(|key| selectors.iter().any(|s| s.matches(key)))
            {
                layouts.insert(id, keys);
            }
        }
        Ok(layouts)
    }

    /// Fine-tier coverage measured back from the requested end. A missing prune mark
    /// means the store has not removed any rows from that tier.
    pub fn history_tier_coverage(&mut self, host: HostId, to_ms: i64) -> Result<TierCoverage> {
        let host_ref = self.host_ref(host)?;
        let s10 = self
            .pruned(host_ref, Tier::S10)?
            .map(|(_, cutoff)| cutoff)
            .max(db::read_s10_hole_until(&self.conn)?);
        let minutes = self
            .pruned(host_ref, Tier::M1)?
            .map(|(_, cutoff)| cutoff)
            .max(
                self.pruned_key(host_ref, db::M1_ROLLED)?
                    .map(|(_, cutoff)| cutoff),
            );
        let duration =
            |cutoff: Option<i64>| cutoff.map_or(i64::MAX, |cutoff| to_ms.saturating_sub(cutoff));
        Ok(TierCoverage {
            s10_ms: Some(duration(s10)),
            m1_ms: Some(duration(minutes)),
        })
    }

    /// The tier a [`TierChoice::Auto`] read of `host` over `[from_ms, to_ms)` uses, without
    /// reading it.
    pub fn auto_tier_for(&mut self, host: HostId, from_ms: i64, to_ms: i64) -> Result<Tier> {
        let host_ref = self.host_ref(host)?;
        self.auto_tier(host_ref, from_ms, to_ms)
    }

    pub(super) fn resolve_tier(
        &self,
        host_ref: i64,
        from_ms: i64,
        to_ms: i64,
        choice: TierChoice,
    ) -> Result<Tier> {
        match choice {
            TierChoice::Fixed(tier) => Ok(tier),
            TierChoice::Auto => self.auto_tier(host_ref, from_ms, to_ms),
            TierChoice::Covered(coverage) => {
                covered_tier(coverage, from_ms, to_ms, |tier| match tier {
                    Tier::S10 => self.s10_covers(host_ref, from_ms),
                    _ => self.m1_covers(host_ref, from_ms),
                })
            }
        }
    }

    /// `S10` when the range fits in the 10 s tier's window, pruning has not removed
    /// anything after its start, and low-disk mode left no holes in it (D-057).
    /// Otherwise `M15` when the range starts more than one 15-minute bucket before the
    /// minutes the roll-down has kept (D-076), and `M1` when it does not. The slack keeps
    /// a 7-day range ending now on minutes whether or not the last prune has rolled its
    /// first few minutes down.
    fn auto_tier(&self, host_ref: i64, from_ms: i64, to_ms: i64) -> Result<Tier> {
        if to_ms - from_ms <= Retention::default().s10_ms && self.s10_covers(host_ref, from_ms)? {
            return Ok(Tier::S10);
        }
        let quarter = Tier::M15.bucket_ms().unwrap_or(900_000);
        match self.pruned_key(host_ref, db::M1_ROLLED)? {
            Some((_, rolled_until)) if rolled_until.saturating_sub(from_ms) > quarter => {
                Ok(Tier::M15)
            }
            _ => Ok(Tier::M1),
        }
    }

    fn s10_covers(&self, host_ref: i64, from_ms: i64) -> Result<bool> {
        if db::read_s10_hole_until(&self.conn)?.is_some_and(|until| until > from_ms) {
            return Ok(false);
        }
        Ok(!matches!(
            self.pruned(host_ref, Tier::S10)?,
            Some((_, cutoff)) if cutoff > from_ms
        ))
    }

    /// A fresh mirror can have a later sync floor before its first prune mark.
    fn m1_covers(&self, host_ref: i64, from_ms: i64) -> Result<bool> {
        let start = Tier::M1.bucket_start(from_ms).unwrap_or(from_ms);
        let earliest: Option<i64> = self
            .conn
            .prepare_cached("SELECT min(bucket_ts) FROM tier_1m WHERE host_id = ?1")?
            .query_row(params![host_ref], |row| row.get(0))?;
        Ok(earliest.is_some_and(|ts| ts <= start))
    }
}

pub(super) fn recent_tier(q: &HistoryQuery) -> Result<Tier> {
    match q.tier {
        TierChoice::Fixed(tier) => Ok(tier),
        TierChoice::Auto if q.to_ms - q.from_ms <= Retention::default().s10_ms => Ok(Tier::S10),
        TierChoice::Auto => Ok(Tier::M1),
        TierChoice::Covered(coverage) => covered_tier(coverage, q.from_ms, q.to_ms, |_| Ok(true)),
    }
}

fn covered_tier(
    coverage: TierCoverage,
    from_ms: i64,
    to_ms: i64,
    retains_range: impl Fn(Tier) -> Result<bool>,
) -> Result<Tier> {
    let span = i128::from(to_ms) - i128::from(from_ms);
    for (tier, keep) in [(Tier::S10, coverage.s10_ms), (Tier::M1, coverage.m1_ms)] {
        if keep.is_some_and(|keep| span <= i128::from(keep)) && retains_range(tier)? {
            return Ok(tier);
        }
    }
    Ok(Tier::M15)
}

/// Source buckets and gaps captured by one history read.
pub struct HistorySnapshot<R> {
    query: HistoryQuery,
    tier: Tier,
    width: i64,
    gaps: Vec<Gap>,
    layouts: BTreeMap<u32, Arc<[SeriesKey]>>,
    rows: Vec<HistoryBucketRow>,
    recent: Option<R>,
    selection: Option<HistorySelection>,
}

impl<R: AsRef<[BucketRow]>> HistorySnapshot<R> {
    pub fn series_clamped(&self) -> bool {
        self.selection.as_ref().is_some_and(|s| s.clamped)
    }

    /// Builds points and the newest closed source bucket end represented by them.
    pub fn merge(&self, budget: u32, now: i64) -> Result<(HistoryResult, i64)> {
        let q = &self.query;
        let Some(recent) = &self.recent else {
            return Ok((
                HistoryResult {
                    tier: self.tier,
                    bucket_ms: self.width,
                    series: Vec::new(),
                    gaps: self.gaps.clone(),
                },
                q.from_ms,
            ));
        };
        let mut merge = Merge::new(q, self.width, budget);
        merge.closed_before = now;
        merge.keys = self.selection.as_ref().map(|s| &s.keys);
        let recent = merge.recent(recent.as_ref(), self.tier);
        let recent_ts: HashSet<i64> = recent.iter().map(|r| r.bucket_ts).collect();
        let mut matches: HashMap<u32, Positions> = HashMap::new();
        for (ts, layout_id, stats, weight) in &self.rows {
            let layout = self.layouts.get(layout_id).ok_or_else(|| {
                StoreError::Corrupt(format!("row refers to missing layout {layout_id}"))
            })?;
            // Only the source tier held in the hub can replace a stored row.
            if *weight == 1
                && recent_ts.contains(ts)
                && recent
                    .iter()
                    .any(|r| r.bucket_ts == *ts && r.series == *layout)
            {
                continue;
            }
            let positions = matches
                .entry(*layout_id)
                .or_insert_with(|| merge.positions(layout));
            merge.add(*ts, positions, |i| f32_at(stats, i), *weight)?;
        }
        merge.add_recent(&recent)?;
        let complete_to_ms = merge.complete_to_ms.min(q.to_ms);
        Ok((
            HistoryResult {
                tier: self.tier,
                bucket_ms: merge.slots.slot_w,
                series: merge.finish(),
                gaps: self.gaps.clone(),
            },
            complete_to_ms,
        ))
    }
}

struct HistorySelection {
    keys: BTreeSet<SeriesKey>,
    limit: usize,
    clamped: bool,
}

impl HistorySelection {
    fn new(limit: usize) -> Self {
        Self {
            keys: BTreeSet::new(),
            limit,
            clamped: false,
        }
    }

    fn add(&mut self, layout: &[SeriesKey], selectors: &[SeriesSelector], durable: bool) {
        for key in layout
            .iter()
            .filter(|key| selectors.iter().any(|s| s.matches(key)))
        {
            if self.keys.contains(key) {
                continue;
            }
            if self.keys.len() == self.limit {
                self.clamped = true;
                // Disk reads already used this selection. A recent-only key can
                // fill a vacancy, but cannot replace a key whose rows were fetched.
                if !durable || self.keys.last().is_none_or(|last| key >= last) {
                    continue;
                }
                self.keys.pop_last();
            }
            self.keys.insert(key.clone());
        }
    }
}

pub(super) fn in_recent_range(row: &BucketRow, tier: Tier, from: i64, to: i64) -> bool {
    let want = if tier == Tier::M15 { Tier::M1 } else { tier };
    row.tier == want && row.bucket_ts >= from && row.bucket_ts < to
}
