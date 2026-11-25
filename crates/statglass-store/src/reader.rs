//! Read-only connections: history queries, process lookups, and the cursor read API the
//! sync exporter serves. Any number of readers can run beside the writer (WAL).

use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension, ToSql, params, params_from_iter};
use statglass_schema::{
    Catalog, Cursor, Event, EventDetail, Gap, GapReason, HostId, HostInfo, HostRecord, Labels,
    MetricId, Module, SeriesKey, SyncKinds, SyncRowKind, Tier,
};
use uuid::Uuid;

use crate::blob;
use crate::db::{self, tier_table, tier_width};
use crate::error::{Result, StoreError};
use crate::slots::{Acc, Slots};
use crate::types::{
    BucketRow, CursorPage, CursorRead, HistoryQuery, HistoryResult, PageEvent, PageGap, PageLayout,
    PageRow, Point, ProcResolution, ProcRow, ProcessesAt, SeriesPoints,
};

mod export;
mod growth;
mod heatmap;
mod inventory;
mod net;
mod stats;
mod summary;
mod tiers;
use tiers::in_recent_range;
mod usage;
mod usage_growth;
pub use usage_growth::UsageHistoryGrowth;

pub use export::{ExportQuery, ExportSummary};
pub use growth::{HistoryGrowth, MIN_MEASURED_MS};
pub use inventory::{EventsRead, RetainedSpan};
pub use net::net_by_app_recent;
pub use stats::{MetricStats, RangeStats, range_stats};
pub use summary::{BucketValue, SeriesSummaries, SeriesSummary, series_summary};

/// How far from the requested instant a process snapshot still counts as "at" it: half
/// the widest snapshot spacing (30 s in Performance mode, D-088), so an instant between
/// two snapshots always finds one.
const PROC_SNAP_TOLERANCE_MS: i64 = 15_000;

/// A read-only connection with its own caches. Not shared between threads; open one per
/// thread with [`crate::Store::reader`].
pub struct Reader {
    conn: Connection,
    epoch: Uuid,
    hosts: HashMap<HostId, i64>,
    /// Layouts are immutable once minted, so this never goes stale.
    layouts: HashMap<u32, Arc<[SeriesKey]>>,
    #[cfg(test)]
    history_rows_read: usize,
}

impl Reader {
    /// Open an independent read-only connection for a worker history request.
    pub fn open(path: &std::path::Path) -> Result<Self> {
        let (conn, epoch) = db::open_reader(path)?;
        Ok(Self::new(conn, epoch))
    }
    /// Seed a new process's independent Docker generation/revision counters. Wall
    /// clock rollback must not strand persistence behind a prior process's counters.
    pub fn docker_watermark(&self, host: HostId) -> Result<(i64, i64)> {
        Ok(self.conn.query_row("SELECT coalesce(max(e.generation),0),coalesce(max(e.durable_revision),0) FROM docker_engines e JOIN hosts h ON h.id=e.host_id WHERE h.uuid=?1",[host.to_string()],|r|Ok((r.get(0)?,r.get(1)?)))?)
    }

    pub fn docker_snapshot(
        &mut self,
        host: HostId,
        daemon: &str,
    ) -> Result<crate::docker::DockerReadSnapshot<'_>> {
        crate::docker::read::begin(&self.conn, host, daemon)
    }
    pub fn docker_catalog(
        &mut self,
        host: HostId,
        engine: Option<&str>,
        search: &str,
        offset: usize,
        limit: usize,
    ) -> Result<crate::docker::DockerCatalog> {
        self.docker_snapshot(host, engine.unwrap_or(""))?
            .catalog(engine, search, offset, limit)
    }
    pub(crate) fn new(conn: Connection, epoch: Uuid) -> Self {
        Self {
            conn,
            epoch,
            hosts: HashMap::new(),
            layouts: HashMap::new(),
            #[cfg(test)]
            history_rows_read: 0,
        }
    }

    /// This database's `db_instance_uuid`.
    pub fn epoch(&self) -> Uuid {
        self.epoch
    }

    /// Whether the connection is inside a transaction, holding a read snapshot. A pool
    /// must drop such a reader rather than reuse it.
    pub fn in_transaction(&self) -> bool {
        !self.conn.is_autocommit()
    }

    /// Every host record, local first.
    pub fn hosts(&self) -> Result<Vec<HostRecord>> {
        self.host_records("SELECT uuid, is_local, name, info FROM hosts ORDER BY is_local DESC, id")
    }

    /// The local host, if one was ever registered. The `hosts_one_local` index allows at
    /// most one, so this is how a lost `host-id` file is recovered (D-051, D-064).
    pub fn local_host(&self) -> Result<Option<HostRecord>> {
        Ok(self
            .host_records("SELECT uuid, is_local, name, info FROM hosts WHERE is_local = 1")?
            .pop())
    }

    fn host_records(&self, sql: &str) -> Result<Vec<HostRecord>> {
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, bool>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Vec<u8>>(3)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (uuid, is_local, name, info) = row?;
            let id = Uuid::parse_str(&uuid)
                .map_err(|e| StoreError::Corrupt(format!("host uuid {uuid}: {e}")))?;
            let info: HostInfo = ciborium::from_reader(info.as_slice())
                .map_err(|e| StoreError::Cbor(e.to_string()))?;
            out.push(HostRecord {
                id: HostId(id),
                is_local,
                display_name: name,
                info,
            });
        }
        Ok(out)
    }

    fn host_ref(&mut self, host: HostId) -> Result<i64> {
        if let Some(&r) = self.hosts.get(&host) {
            return Ok(r);
        }
        let r: i64 = self
            .conn
            .prepare_cached("SELECT id FROM hosts WHERE uuid = ?1")?
            .query_row([host.to_string()], |r| r.get(0))
            .optional()?
            .ok_or(StoreError::UnknownHost(host))?;
        self.hosts.insert(host, r);
        Ok(r)
    }

    fn layout(&mut self, id: u32) -> Result<Arc<[SeriesKey]>> {
        load_layout(&self.conn, &mut self.layouts, id)
    }

    /// The `pruned` mark of `(host, tier)`: (highest pruned seq, cutoff ts).
    fn pruned(&self, host_ref: i64, tier: Tier) -> Result<Option<(i64, i64)>> {
        self.pruned_key(host_ref, tier.as_str())
    }

    /// A `pruned` row by key: a tier, or [`db::M1_ROLLED`].
    fn pruned_key(&self, host_ref: i64, key: &str) -> Result<Option<(i64, i64)>> {
        Ok(self
            .conn
            .prepare_cached("SELECT seq, ts FROM pruned WHERE host_id = ?1 AND tier = ?2")?
            .query_row(params![host_ref, key], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?)
    }

    // --- history --------------------------------------------------------------------------

    /// `query_history`: per-series points from one tier, merged down to `max_points`, plus
    /// the gaps overlapping the range. Stored rows alone; see [`Reader::history_after`].
    pub fn history(&mut self, q: &HistoryQuery) -> Result<HistoryResult> {
        self.history_after(q, Vec::new)
    }

    /// [`Reader::history`] over the stored rows and `recent`: the engine's bucket rows
    /// since its last commit and its open buckets flushed as they are (D-092). The writer
    /// commits every 5 minutes, so the newest buckets are not in the file yet. A recent
    /// row replaces the stored row of the same tier, bucket and layout (what the writer's
    /// upsert will do), so a bucket both committed and still held counts once. `recent`
    /// is called after the stored rows are read: the engine keeps a row before it queues
    /// it to the writer, so a copy taken after the read is never older than the stored
    /// row it replaces. Rows of other tiers are ignored; an M15 read takes recent minutes
    /// as it takes the stored ones.
    pub fn history_after<R: AsRef<[BucketRow]>>(
        &mut self,
        q: &HistoryQuery,
        recent: impl FnOnce() -> R,
    ) -> Result<HistoryResult> {
        self.history_snapshot(q, None, recent)?
            .merge(q.max_points, i64::MAX)
            .map(|(result, _)| result)
    }

    /// Gaps of `host` overlapping `[from, to)`, by start.
    pub fn gaps(&mut self, host: HostId, from_ms: i64, to_ms: i64) -> Result<Vec<Gap>> {
        let host_ref = self.host_ref(host)?;
        self.gaps_in(host_ref, from_ms, to_ms)
    }

    fn gaps_in(&self, host_ref: i64, from: i64, to: i64) -> Result<Vec<Gap>> {
        let rows = self
            .conn
            .prepare_cached(
                "SELECT start_ts, end_ts, module, reason FROM gaps
                 WHERE host_id = ?1 AND start_ts < ?3 AND (end_ts IS NULL OR end_ts > ?2)
                 ORDER BY start_ts",
            )?
            .query_map(params![host_ref, from, to], gap_from_row)?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    // --- events ---------------------------------------------------------------------------

    /// `query_events`: the events with `from_ms <= ts < to_ms`, oldest first. A payload
    /// this build cannot decode, a kind from a newer build among them, is skipped (D-083).
    /// [`Reader::events_counted`] reports how many were skipped.
    pub fn events(&mut self, host: HostId, from_ms: i64, to_ms: i64) -> Result<Vec<Event>> {
        Ok(self.events_counted(host, from_ms, to_ms)?.events)
    }

    /// The newest matching events in the range, returned oldest first as stored rows.
    /// Fixed kinds are selected in SQL. Only alert payloads are decoded for classification.
    pub fn event_rows(
        &mut self,
        host: HostId,
        from_ms: i64,
        to_ms: i64,
        limit: usize,
        module: Module,
        catalog: &Catalog,
    ) -> Result<Vec<PageEvent>> {
        let host_ref = self.host_ref(host)?;
        let module = module.event_module();
        let kinds: Vec<_> = EventDetail::KINDS
            .iter()
            .filter(|&&kind| kind == "alert" || EventDetail::fixed_module(kind) == Some(module))
            .collect();
        let placeholders = vec!["?"; kinds.len()].join(",");
        let sql = format!(
            "SELECT export_id, seq, ts, kind, payload FROM events
             WHERE host_id = ? AND ts >= ? AND ts < ? AND kind IN ({placeholders})
             ORDER BY ts DESC, kind DESC, id DESC"
        );
        let mut stmt = self.conn.prepare_cached(&sql)?;
        let bounds: [&dyn ToSql; 3] = [&host_ref, &from_ms, &to_ms];
        let kinds = kinds.iter().map(|kind| kind as &dyn ToSql);
        let mut rows = stmt.query(params_from_iter(bounds.into_iter().chain(kinds)))?;
        let mut events = Vec::new();
        while events.len() < limit
            && let Some(row) = rows.next()?
        {
            let kind: String = row.get(3)?;
            let payload: Vec<u8> = row.get(4)?;
            if kind == "alert" {
                match ciborium::from_reader::<Event, _>(payload.as_slice()) {
                    Ok(event) if event.detail.module(catalog) == Some(module) => {}
                    Ok(_) => continue,
                    Err(error) => {
                        tracing::debug!(
                            error = &error as &dyn std::error::Error,
                            "skipping an alert this build cannot decode"
                        );
                        continue;
                    }
                }
            }
            events.push(PageEvent {
                source_id: row.get(0)?,
                seq: row.get(1)?,
                ts_ms: row.get(2)?,
                kind,
                payload,
            });
        }
        events.reverse();
        Ok(events)
    }

    // --- processes ------------------------------------------------------------------------

    /// `query_processes_at`: the snapshot nearest `t_ms` (within 15 s), else the
    /// top-5 minute containing it, else the top-5 15 minutes containing it, else `None`.
    pub fn processes_at(&mut self, host: HostId, t_ms: i64) -> Result<Option<ProcessesAt>> {
        let host_ref = self.host_ref(host)?;
        let snap: Option<(i64, Vec<u8>)> = self
            .conn
            .prepare_cached(
                "SELECT ts, blob FROM proc_snap
                 WHERE host_id = ?1 AND ts BETWEEN ?2 - ?3 AND ?2 + ?3
                 ORDER BY abs(ts - ?2), ts LIMIT 1",
            )?
            .query_row(params![host_ref, t_ms, PROC_SNAP_TOLERANCE_MS], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?;
        let (ts, packed, resolution) = match snap {
            Some((ts, b)) => (ts, b, ProcResolution::Snapshot),
            None => {
                let minute = Tier::M1.bucket_start(t_ms).unwrap_or(t_ms);
                let top: Option<Vec<u8>> = self
                    .conn
                    .prepare_cached(
                        "SELECT blob FROM proc_top_1m WHERE host_id = ?1 AND bucket_ts = ?2",
                    )?
                    .query_row(params![host_ref, minute], |r| r.get(0))
                    .optional()?;
                match top {
                    Some(b) => (minute, b, ProcResolution::Top5PerMinute),
                    None => {
                        let quarter = Tier::M15.bucket_start(t_ms).unwrap_or(t_ms);
                        let top: Option<Vec<u8>> = self
                            .conn
                            .prepare_cached(
                                "SELECT blob FROM proc_top_15m WHERE host_id = ?1 AND bucket_ts = ?2",
                            )?
                            .query_row(params![host_ref, quarter], |r| r.get(0))
                            .optional()?;
                        match top {
                            Some(b) => (quarter, b, ProcResolution::Top5Per15Minutes),
                            None => return Ok(None),
                        }
                    }
                }
            }
        };
        let mut names: HashMap<u32, String> = HashMap::new();
        let mut rows = Vec::new();
        for p in blob::unpack_procs(&packed)? {
            let name = match names.get(&p.name_id) {
                Some(n) => n.clone(),
                None => {
                    let n: String = self
                        .conn
                        .prepare_cached("SELECT name FROM proc_names WHERE id = ?1")?
                        .query_row([p.name_id], |r| r.get(0))
                        .optional()?
                        .ok_or_else(|| {
                            StoreError::Corrupt(format!("missing process name {}", p.name_id))
                        })?;
                    names.insert(p.name_id, n.clone());
                    n
                }
            };
            rows.push(ProcRow {
                name,
                pid: p.pid,
                cpu_pct: p.cpu,
                mem_bytes: u64::from(p.mem_kib) * 1024,
                threads: p.threads,
                idle_wakeups_per_s: p.wakeups,
                energy: p.energy,
            });
        }
        Ok(Some(ProcessesAt {
            ts_ms: ts,
            resolution,
            rows,
        }))
    }

    // --- cursors --------------------------------------------------------------------------

    /// Exporter side of sync: up to `max_rows` persisted rows of `host` in `tier` with
    /// `seq` after the cursor, in `seq` order. `M1` pages also carry gaps and events
    /// (D-041). Only the row kinds in `kinds` (what the connection negotiated) are read;
    /// the page's `last_seq` still moves past the others, which is why the receiver keeps
    /// `kinds` with its cursor (D-064). `M15` rows travel only with
    /// [`SyncRowKind::M15`]. A cursor from another database (`epoch` differs) reads from
    /// the start; a cursor that pruning has passed gets [`CursorRead::Truncated`]. For a
    /// receiver without `M15`, minutes rolled down into M15 count as pruned from its M1
    /// cursor, so it records a gap rather than a silent hole (D-076).
    pub fn read_after(
        &mut self,
        host: HostId,
        tier: Tier,
        after: Option<Cursor>,
        max_rows: u32,
        kinds: SyncKinds,
    ) -> Result<CursorRead> {
        self.read_after_since(host, tier, after, max_rows, kinds, None)
    }

    /// Cursor export bounded by a source-clock retention floor. Gaps overlapping the
    /// floor are included, including open gaps. Limits are clamped to 1..=2000.
    #[expect(
        clippy::too_many_lines,
        reason = "split when substantially changed; architecture refactor section 10"
    )]
    pub fn read_after_since(
        &mut self,
        host: HostId,
        tier: Tier,
        after: Option<Cursor>,
        max_rows: u32,
        kinds: SyncKinds,
        from_ms: Option<i64>,
    ) -> Result<CursorRead> {
        let max_rows = max_rows.clamp(1, 2000);
        let floor = from_ms.unwrap_or(i64::MIN);
        let host_ref = self.host_ref(host)?;
        let table = tier_table(tier)?;
        let after_seq = match after {
            Some(c) if c.epoch == self.epoch => {
                let mut earliest = None;
                if let Some((pruned_seq, cutoff)) = self.pruned(host_ref, tier)?
                    && pruned_seq > c.seq
                {
                    earliest = Some(cutoff);
                }
                if tier == Tier::M1
                    && !kinds.contains(SyncRowKind::M15)
                    && let Some((rolled_seq, cutoff)) = self.pruned_key(host_ref, db::M1_ROLLED)?
                    && rolled_seq > c.seq
                {
                    earliest = earliest.max(Some(cutoff));
                }
                if let Some(earliest_ts_ms) = earliest {
                    return Ok(CursorRead::Truncated {
                        tier,
                        earliest_ts_ms,
                        epoch: self.epoch,
                    });
                }
                c.seq
            }
            _ => 0,
        };
        let limit = i64::from(max_rows) + 1;

        enum Item {
            Row(i64, u32, Vec<u8>),
            Gap(i64, Gap),
            Event(i64, i64, String, Vec<u8>),
        }
        let mut items: Vec<(i64, Item)> = Vec::new();
        let bucket_kind = if tier == Tier::M15 {
            SyncRowKind::M15
        } else {
            SyncRowKind::Buckets
        };
        if kinds.contains(bucket_kind) {
            items = self
                .conn
                .prepare_cached(&format!(
                    "SELECT seq, bucket_ts, layout_id, blob FROM {table}
                     WHERE host_id = ?1 AND seq > ?2 AND bucket_ts >= ?4 ORDER BY seq LIMIT ?3"
                ))?
                .query_map(params![host_ref, after_seq, limit, floor], |r| {
                    Ok((r.get(0)?, Item::Row(r.get(1)?, r.get(2)?, r.get(3)?)))
                })?
                .collect::<rusqlite::Result<_>>()?;
        }
        if tier == Tier::M1 && kinds.contains(SyncRowKind::Gaps) {
            let gaps = self
                .conn
                .prepare_cached(
                    "SELECT start_ts, end_ts, module, reason, seq, export_id FROM gaps
                     WHERE host_id = ?1 AND seq > ?2 AND (end_ts IS NULL OR end_ts >= ?4) ORDER BY seq LIMIT ?3",
                )?
                .query_map(params![host_ref, after_seq, limit, floor], |r| {
                    Ok((r.get(4)?, Item::Gap(r.get(5)?, gap_from_row(r)?)))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            items.extend(gaps);
        }
        if tier == Tier::M1 && kinds.contains(SyncRowKind::Events) {
            let events = self
                .conn
                .prepare_cached(
                    "SELECT seq, export_id, ts, kind, payload FROM events
                     WHERE host_id = ?1 AND seq > ?2 AND ts >= ?4 ORDER BY seq LIMIT ?3",
                )?
                .query_map(params![host_ref, after_seq, limit, floor], |r| {
                    Ok((
                        r.get(0)?,
                        Item::Event(r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?),
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            items.extend(events);
        }
        items.sort_by_key(|(seq, _)| *seq);
        let more = items.len() > max_rows as usize;
        items.truncate(max_rows as usize);

        let mut page = CursorPage {
            tier,
            epoch: self.epoch,
            kinds,
            layouts: Vec::new(),
            rows: Vec::new(),
            gaps: Vec::new(),
            events: Vec::new(),
            last_seq: items.last().map_or(after_seq, |(seq, _)| *seq),
            more,
        };
        let mut layout_nos: HashMap<u32, u32> = HashMap::new();
        for (seq, item) in items {
            match item {
                Item::Row(bucket_ts, layout_id, stats) => {
                    let layout_no = match layout_nos.get(&layout_id) {
                        Some(&n) => n,
                        None => {
                            let n = page.layouts.len() as u32;
                            page.layouts.push(PageLayout {
                                layout_no: n,
                                series: self.layout(layout_id)?.to_vec(),
                            });
                            layout_nos.insert(layout_id, n);
                            n
                        }
                    };
                    page.rows.push(PageRow {
                        seq,
                        bucket_ts,
                        layout_no,
                        stats: blob::unpack_f32s(&stats)?,
                    });
                }
                Item::Gap(source_id, gap) => page.gaps.push(PageGap {
                    source_id: Some(source_id),
                    seq,
                    gap,
                }),
                Item::Event(source_id, ts_ms, kind, payload) => page.events.push(PageEvent {
                    source_id: Some(source_id),
                    seq,
                    ts_ms,
                    kind,
                    payload,
                }),
            }
        }
        Ok(CursorRead::Page(page))
    }

    /// Controller side: the stored sync position for `(host, tier)` and the row kinds it
    /// covered, if any.
    pub fn cursor(&mut self, host: HostId, tier: Tier) -> Result<Option<(Cursor, SyncKinds)>> {
        let host_ref = self.host_ref(host)?;
        let row: Option<(String, i64, String)> = self
            .conn
            .prepare_cached(
                "SELECT epoch, seq, kinds FROM cursors WHERE host_id = ?1 AND tier = ?2",
            )?
            .query_row(params![host_ref, tier.as_str()], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .optional()?;
        row.map(|(epoch, seq, kinds)| {
            let epoch = Uuid::parse_str(&epoch)
                .map_err(|e| StoreError::Corrupt(format!("cursor epoch {epoch}: {e}")))?;
            Ok((Cursor { epoch, seq }, SyncKinds::from_stored(&kinds)))
        })
        .transpose()
    }

    /// Controller side: the cursor to send in a `SyncRequest` to a remote database whose
    /// current epoch is `remote_epoch`, on a connection that negotiated `kinds`. `None`
    /// (start from the earliest row) when there is no cursor, it belongs to an earlier
    /// incarnation of that database, or it was built without one of `kinds`: the sender
    /// moved it past rows of that kind it could not send then (D-064). Replaying is
    /// harmless, ingest is idempotent.
    pub fn resume_cursor(
        &mut self,
        host: HostId,
        tier: Tier,
        remote_epoch: Uuid,
        kinds: SyncKinds,
    ) -> Result<Option<Cursor>> {
        Ok(self
            .cursor(host, tier)?
            .filter(|(c, covered)| c.epoch == remote_epoch && covered.covers(kinds))
            .map(|(c, _)| c))
    }
}

/// `query_history` from the engine's recent bucket rows alone (D-092): what a history
/// query can still answer while the store is unavailable and the app runs live-only.
/// Tier selection uses the coverage windows without store markers. No gaps are on record.
pub fn history_recent(q: &HistoryQuery, recent: &[BucketRow]) -> Result<HistoryResult> {
    let tier = tiers::recent_tier(q)?;
    let width = tier_width(tier)?;
    if q.to_ms <= q.from_ms || q.selectors.is_empty() {
        return Ok(HistoryResult {
            tier,
            bucket_ms: width,
            series: Vec::new(),
            gaps: Vec::new(),
        });
    }
    let mut merge = Merge::new(q, width, q.max_points);
    let recent = merge.recent(recent, tier);
    merge.add_recent(&recent)?;
    Ok(HistoryResult {
        tier,
        bucket_ms: merge.slots.slot_w,
        series: merge.finish(),
        gaps: Vec::new(),
    })
}

/// A history read in progress: per-series accumulators on the [`Slots`] grid.
struct Merge<'q> {
    q: &'q HistoryQuery,
    slots: Slots,
    keys: Option<&'q BTreeSet<SeriesKey>>,
    closed_before: i64,
    complete_to_ms: i64,
    /// Result series in key order.
    index: BTreeMap<SeriesKey, usize>,
    /// Per series, accumulators by slot index.
    accs: Vec<BTreeMap<i64, Acc>>,
}

impl<'q> Merge<'q> {
    fn new(q: &'q HistoryQuery, width: i64, budget: u32) -> Self {
        Self {
            q,
            slots: Slots::new(q.from_ms, q.to_ms, width, budget),
            keys: None,
            closed_before: i64::MAX,
            complete_to_ms: q.from_ms,
            index: BTreeMap::new(),
            accs: Vec::new(),
        }
    }

    /// The recent rows a read of `tier` takes: that tier's (minutes for an M15 read),
    /// inside the range.
    fn recent<'r>(&self, rows: &'r [BucketRow], tier: Tier) -> Vec<&'r BucketRow> {
        rows.iter()
            .filter(|r| in_recent_range(r, tier, self.slots.base, self.q.to_ms))
            .collect()
    }

    /// (result index, position in layout) of each series in `layout` a selector matches.
    fn positions(&mut self, layout: &[SeriesKey]) -> Positions {
        let mut m = Vec::new();
        for (pos, key) in layout.iter().enumerate() {
            let selected = self.keys.map_or_else(
                || self.q.selectors.iter().any(|s| s.matches(key)),
                |keys| keys.contains(key),
            );
            if selected {
                let next = self.index.len();
                let i = *self.index.entry(key.clone()).or_insert(next);
                if i == self.accs.len() {
                    self.accs.push(BTreeMap::new());
                }
                m.push((i, pos));
            }
        }
        m
    }

    /// Adds one bucket row; `stat(i)` is the `i`th value of its `(min, max, avg)` triples.
    fn add(
        &mut self,
        ts: i64,
        positions: &[(usize, usize)],
        stat: impl Fn(usize) -> Option<f32>,
        weight: u32,
    ) -> Result<()> {
        let slot = self.slots.index(ts);
        let mut measured = false;
        for &(i, pos) in positions {
            let (Some(min), Some(max), Some(avg)) =
                (stat(pos * 3), stat(pos * 3 + 1), stat(pos * 3 + 2))
            else {
                return Err(StoreError::Corrupt(format!(
                    "bucket at {ts} is shorter than its layout"
                )));
            };
            // NaN: in the layout but never sampled in this bucket. Not a value.
            if avg.is_nan() {
                continue;
            }
            if let Some(a) = self.accs.get_mut(i) {
                a.entry(slot).or_default().add(min, max, avg, weight);
                measured = true;
            }
        }
        let end = ts.saturating_add(self.slots.unit_w * i64::from(weight));
        if measured && end <= self.closed_before {
            self.complete_to_ms = self.complete_to_ms.max(end);
        }
        Ok(())
    }

    /// Adds the recent rows, each weighing one bucket of its tier.
    fn add_recent(&mut self, rows: &[&BucketRow]) -> Result<()> {
        // Rows of one layout share one `Arc`.
        let mut matches: Vec<(Arc<[SeriesKey]>, Positions)> = Vec::new();
        for r in rows {
            let k = match matches.iter().position(|(l, _)| Arc::ptr_eq(l, &r.series)) {
                Some(k) => k,
                None => {
                    let m = self.positions(&r.series);
                    matches.push((Arc::clone(&r.series), m));
                    matches.len() - 1
                }
            };
            let positions = matches.get(k).map_or(&[][..], |(_, m)| m.as_slice());
            self.add(r.bucket_ts, positions, |i| r.stats.get(i).copied(), 1)?;
        }
        Ok(())
    }

    fn finish(mut self) -> Vec<SeriesPoints> {
        let mut series = Vec::new();
        for (key, i) in std::mem::take(&mut self.index) {
            let Some(slots) = self.accs.get_mut(i) else {
                continue;
            };
            let points: Vec<Point> = std::mem::take(slots)
                .into_iter()
                .map(|(slot, a)| self.slots.point(slot, &a, key.metric.as_str()))
                .collect();
            if !points.is_empty() {
                series.push(SeriesPoints { key, points });
            }
        }
        series
    }
}

/// (result index, position in layout) of each series of a layout a read selects.
type Positions = Vec<(usize, usize)>;
type HistoryBucketRow = (i64, u32, Vec<[f32; 3]>, u32);

/// The series of layout `id`, through `cache`. A free function so a caller can hold a
/// statement on `conn` while it resolves layouts (the borrows are disjoint).
pub(crate) fn load_layout(
    conn: &Connection,
    cache: &mut HashMap<u32, Arc<[SeriesKey]>>,
    id: u32,
) -> Result<Arc<[SeriesKey]>> {
    if let Some(l) = cache.get(&id) {
        return Ok(Arc::clone(l));
    }
    let packed: Vec<u8> = conn
        .prepare_cached("SELECT series_ids FROM layouts WHERE id = ?1")?
        .query_row([id], |r| r.get(0))
        .optional()?
        .ok_or_else(|| StoreError::Corrupt(format!("row refers to missing layout {id}")))?;
    let mut keys = Vec::new();
    for sid in blob::unpack_u32s(&packed)? {
        let (metric, labels): (String, String) = conn
            .prepare_cached("SELECT metric_id, labels FROM series WHERE id = ?1")?
            .query_row([sid], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?
            .ok_or_else(|| {
                StoreError::Corrupt(format!("layout {id} names missing series {sid}"))
            })?;
        let labels = Labels::parse_canonical(&labels)
            .map_err(|e| StoreError::Corrupt(format!("series {sid} labels: {e}")))?;
        // Not validated: a metric from a newer peer is kept as-is and ignored by
        // readers that do not know it.
        keys.push(SeriesKey::new(MetricId(Cow::Owned(metric)), labels));
    }
    let layout: Arc<[SeriesKey]> = keys.into();
    cache.insert(id, Arc::clone(&layout));
    Ok(layout)
}

fn f32_at(blob: &[u8], i: usize) -> Option<f32> {
    let bytes = blob.get(i * 4..i * 4 + 4)?;
    Some(f32::from_le_bytes(bytes.try_into().ok()?))
}

/// Builds a [`Gap`] from `(start_ts, end_ts, module, reason)`. Text this build does not
/// know reads as `Unknown` (D-040).
fn gap_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Gap> {
    let module: Option<String> = r.get(2)?;
    let reason: String = r.get(3)?;
    Ok(Gap {
        start_ms: r.get(0)?,
        end_ms: r.get(1)?,
        module: module.map(|m| Module::parse(&m).unwrap_or(Module::Unknown)),
        reason: GapReason::from_stored(&reason),
    })
}

#[cfg(test)]
mod history_layout_tests {
    use super::*;
    use crate::types::TierChoice;
    use statglass_schema::SeriesSelector;

    #[test]
    fn history_only_fetches_selected_layout_rows_in_both_m15_sources() {
        const DAY: i64 = 86_400_000;
        const M1_ROWS: i64 = 7 * DAY / 60_000;
        const M15_ROWS: i64 = 23 * DAY / 900_000;
        let dir = crate::test_dir("history-layout");
        let path = dir.path().join("history.sqlite");
        let (conn, _) = db::open_writer(&path, 0).unwrap();
        let host = HostId(Uuid::nil());
        conn.execute(
            "INSERT INTO hosts (id, uuid, is_local, name, info, created_ms)
             VALUES (1, ?1, 1, 'fixture', x'', 0)",
            [host.to_string()],
        )
        .unwrap();
        for (id, labels) in [(1_u32, "iface=en0"), (2, "iface=en1")] {
            conn.execute(
                "INSERT INTO series (id, host_id, metric_id, labels) VALUES (?1, 1, 'net.rx', ?2)",
                params![id, labels],
            )
            .unwrap();
            let packed = blob::pack_u32s(&[id]);
            conn.execute(
                "INSERT INTO layouts (id, host_id, series_ids, hash, created_ms)
                 VALUES (?1, 1, ?2, ?2, 0)",
                params![id, packed],
            )
            .unwrap();
            for (table, start, step, count, avg) in [
                ("tier_15m", 0, 900_000, M15_ROWS, 3.0),
                ("tier_1m", 23 * DAY, 60_000, M1_ROWS, 7.0),
            ] {
                // A short blob would fail if this series were selected.
                let payload = if id == 1 {
                    blob::pack_f32s(&[avg - 1.0, avg + 1.0, avg])
                } else {
                    Vec::new()
                };
                conn.execute(
                    &format!(
                        "WITH RECURSIVE offsets(n) AS (
                       SELECT 0 UNION ALL SELECT n + 1 FROM offsets WHERE n + 1 < ?5
                     )
                     INSERT INTO {table} (host_id, bucket_ts, layout_id, seq, blob)
                     SELECT 1, ?3 + n * ?4, ?1, n + 1, ?2 FROM offsets"
                    ),
                    params![id, payload, start, step, count],
                )
                .unwrap();
            }
        }
        conn.execute_batch(
            "INSERT INTO layouts (id, host_id, series_ids, hash, created_ms)
               VALUES (3, 1, x'01', x'03', 0);
             INSERT INTO tier_15m (host_id, bucket_ts, layout_id, seq, blob)
               VALUES (1, -900000, 3, 1, x'');",
        )
        .unwrap();
        let mut reader = Reader::open(&path).unwrap();
        let key = SeriesKey::parse("net.rx{iface=en0}").unwrap();
        let selectors = vec![SeriesSelector {
            metric: key.metric.clone(),
            labels: key.labels.clone(),
        }];
        let mut query = HistoryQuery {
            host,
            selectors,
            from_ms: 0,
            to_ms: 30 * DAY,
            tier: TierChoice::Fixed(Tier::M15),
            max_points: 200,
        };
        let read = reader.history(&query).unwrap();
        let expected_rows = usize::try_from(M1_ROWS + M15_ROWS).unwrap();
        assert_eq!(reader.history_rows_read, expected_rows);
        assert_eq!(read.series.len(), 1);
        assert_eq!(read.series[0].key, key);
        assert!(read.series[0].points.len() > 100);
        assert_eq!(read.series[0].points.first().unwrap().avg, 3.0);
        assert_eq!(read.series[0].points.last().unwrap().avg, 7.0);

        query.selectors[0].labels = Labels::new();
        let snapshot = reader.history_snapshot(&query, Some(1), Vec::new).unwrap();
        let (limited, _) = snapshot.merge(query.max_points, 30 * DAY).unwrap();
        assert_eq!(reader.history_rows_read, expected_rows);
        assert!(snapshot.series_clamped());
        assert_eq!(limited, read);
    }
}
