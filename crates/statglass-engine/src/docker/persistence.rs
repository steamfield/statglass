//! Bounded Docker ring and SQLite coordination. Persistence failures release write pins;
//! immutable reader snapshots own their own copies until the bounded query completes.
use super::DockerServiceError;
use statglass_schema::{HostId, Tier, TimeRange, ceil_to, docker as api, floor_to, lock::LockExt};
use statglass_store::{Reader, Writer, docker as db};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    path::PathBuf,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicI64, Ordering},
        mpsc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
mod catalog;
mod comparison;
mod coverage;
mod events;
mod history;
mod ingestion;
mod observation;
mod projection;
mod retention;
mod writes;

use coverage::written_coverage;
use observation::{metadata, observe};
#[cfg(test)]
use projection::point;
#[cfg(test)]
use retention::evict_entry;
use retention::{
    bound_coverage, bucket_bytes, coverage_row, evict, gap, held_coverage, recount_aux,
};
use writes::{drain, queue, requeue};
#[cfg(test)]
use writes::{drain_at, should_warn};

const RING_BYTES: usize = 64 * 1024 * 1024;
/// How long a bucket stays in the ring once persisted: past the 60 s span cap on late
/// observations, with slack.
const PERSISTED_KEEP_MS: i64 = 120_000;
const HOUR: i64 = 3_600_000;
/// Width of a ring bucket: the S10 tier's. The client snaps Docker ranges to it.
pub const DOCKER_BUCKET_MS: i64 = Tier::S10.bucket_ms().expect("S10 has a bucket width");
type Key = (String, String, i64);
/// A closed coverage record: container, reason, start and end.
type CoverageKey = (Option<String>, String, i64, i64);
fn coverage_key(g: &api::DockerCoverage) -> Option<CoverageKey> {
    g.end_ms.map(|end| {
        (
            g.container_id.clone(),
            g.reason().to_owned(),
            g.start_ms,
            end,
        )
    })
}
/// How soon restore reads the store again after it failed, doubling up to the cap.
const RESTORE_RETRY_MIN: Duration = Duration::from_secs(30);
const RESTORE_RETRY_MAX: Duration = Duration::from_secs(30 * 60);
#[derive(Clone)]
struct Attached {
    writer: Writer,
    path: PathBuf,
    coordination: Arc<Mutex<()>>,
}
struct Entry {
    bucket: Arc<db::DockerBucket>,
    bytes: usize,
    pins: usize,
    durable: i64,
}
#[derive(Default)]
struct Retry {
    events: Vec<db::DockerEvent>,
    coverage: Vec<db::DockerCoverage>,
    entities: Vec<db::DockerEntity>,
    cursor: Option<db::DockerCursor>,
}
struct Receipt {
    rx: mpsc::Receiver<db::DockerAck>,
    retry: Retry,
    keys: Vec<Key>,
    engine: String,
    start: i64,
    end: i64,
}
struct SharedReadBucket {
    key: Key,
    bucket: Weak<db::DockerBucket>,
    bytes: usize,
}
struct State {
    generation: u32,
    reset_epoch: u64,
    suspended: bool,
    generation_floor: u32,
    revision: i64,
    entries: BTreeMap<Key, Entry>,
    metadata: BTreeMap<(String, String), api::DockerContainer>,
    observed: BTreeMap<(String, String), i64>,
    fingerprints: BTreeMap<(String, String), Vec<u8>>,
    facts: BTreeMap<(String, String), db::DockerEntity>,
    metadata_history: VecDeque<(String, db::DockerEntity)>,
    population_facts: BTreeMap<(String, i64), db::DockerPopulation>,
    populations: BTreeMap<String, (i64, Vec<String>)>,
    events: VecDeque<api::DockerEvent>,
    coverage: BTreeMap<String, Vec<api::DockerCoverage>>,
    pending: Vec<Receipt>,
    retry: BTreeMap<String, Retry>,
    last_warning: BTreeMap<String, i64>,
    bytes: usize,
    aux_bytes: usize,
    reader_bytes: usize,
    shared_read_buckets: BTreeMap<usize, SharedReadBucket>,
    error: Option<String>,
    runtime: BTreeMap<String, String>,
    restored_coverage: BTreeSet<String>,
    /// When a failed restore may read the store again, and the backoff it used.
    restore_retry: BTreeMap<String, (Instant, Duration)>,
    /// Closed records in `coverage` the store has acknowledged saving.
    saved_coverage: BTreeMap<String, BTreeSet<CoverageKey>>,
    /// No store is attached: memory is the only copy of a record.
    live_only: bool,
    /// When this recorder first observed each daemon. Restore never closes a crashed
    /// process's record after it: later saved time is this process's own.
    first_observed: BTreeMap<String, i64>,
}
struct ReadPin<'a> {
    state: &'a Mutex<State>,
    bytes: usize,
    generation: u32,
    reset_epoch: u64,
    started: Instant,
}
impl ReadPin<'_> {
    fn valid(&self) -> bool {
        let s = self.state.lock_ok();
        s.generation == self.generation
            && s.reset_epoch == self.reset_epoch
            && self.started.elapsed() <= Duration::from_secs(2)
    }
}
impl Drop for ReadPin<'_> {
    fn drop(&mut self) {
        let mut s = self.state.lock_ok();
        s.reader_bytes = s.reader_bytes.saturating_sub(self.bytes);
        recount_aux(&mut s);
    }
}
pub struct DockerRecorder {
    host: HostId,
    epoch: AtomicI64,
    attached: Mutex<Option<Attached>>,
    local_coordination: Arc<Mutex<()>>,
    state: Mutex<State>,
}
impl DockerRecorder {
    pub fn new(host: HostId) -> Self {
        let epoch = wall_ms();
        Self {
            host,
            epoch: AtomicI64::new(epoch),
            attached: Mutex::new(None),
            local_coordination: Arc::new(Mutex::new(())),
            state: Mutex::new(State {
                generation: 0,
                reset_epoch: 0,
                suspended: false,
                generation_floor: 0,
                revision: epoch.saturating_mul(1000),
                entries: BTreeMap::new(),
                metadata: BTreeMap::new(),
                observed: BTreeMap::new(),
                fingerprints: BTreeMap::new(),
                facts: BTreeMap::new(),
                metadata_history: VecDeque::new(),
                population_facts: BTreeMap::new(),
                populations: BTreeMap::new(),
                events: VecDeque::new(),
                coverage: BTreeMap::new(),
                pending: Vec::new(),
                retry: BTreeMap::new(),
                last_warning: BTreeMap::new(),
                bytes: 0,
                aux_bytes: 0,
                reader_bytes: 0,
                shared_read_buckets: BTreeMap::new(),
                error: None,
                runtime: BTreeMap::new(),
                restored_coverage: BTreeSet::new(),
                restore_retry: BTreeMap::new(),
                saved_coverage: BTreeMap::new(),
                live_only: true,
                first_observed: BTreeMap::new(),
            }),
        }
    }

    /// Resume the live ring on every reset exit, including store/path failures.
    pub fn with_suspended<T>(&self, operation: impl FnOnce() -> T) -> T {
        struct Resume<'a>(&'a DockerRecorder);
        impl Drop for Resume<'_> {
            fn drop(&mut self) {
                self.0.resume();
            }
        }
        self.suspend();
        let _resume = Resume(self);
        operation()
    }
    pub fn suspend(&self) {
        let (_, coord) = self.context();
        let _g = coord.lock_ok();
        self.state.lock_ok().suspended = true;
    }
    pub fn resume(&self) {
        self.state.lock_ok().suspended = false;
    }
    pub fn detach(&self) {
        *self.attached.lock_ok() = None;
        self.state.lock_ok().live_only = true;
    }
    pub fn attach(&self, writer: Writer, path: PathBuf) {
        let coordination = writer.docker_snapshot_lock();
        if let Ok(reader) = Reader::open(&path)
            && let Ok((generation, revision)) = reader.docker_watermark(self.host)
        {
            self.epoch
                .fetch_max(generation.saturating_add(1), Ordering::AcqRel);
            let mut s = self.state.lock_ok();
            s.revision = s.revision.max(revision.saturating_add(1));
        }
        {
            let mut state = self.state.lock_ok();
            state.suspended = false;
            state.live_only = false;
            state.restored_coverage.clear();
            state.restore_retry.clear();
            // Another store may not hold what this one saved.
            state.saved_coverage.clear();
        }
        *self.attached.lock_ok() = Some(Attached {
            writer,
            path,
            coordination,
        });
    }
    fn context(&self) -> (Option<Attached>, Arc<Mutex<()>>) {
        let a = self.attached.lock_ok().clone();
        let c = a
            .as_ref()
            .map(|a| Arc::clone(&a.coordination))
            .unwrap_or_else(|| Arc::clone(&self.local_coordination));
        (a, c)
    }

    pub fn status(&self) -> api::DockerPersistence {
        let (a, coord) = self.context();
        let _g = coord.lock_ok();
        let mut s = self.state.lock_ok();
        drain(&mut s);
        let status = a.map(|a| a.writer.docker_storage_status());
        api::DockerPersistence {
            error: s.error.clone(),
            status: if s.error.is_some() {
                "write_failed"
            } else if status.as_ref().is_some_and(|v| v.paused) {
                "paused"
            } else if status.is_some() {
                "recording"
            } else {
                "live_only"
            }
            .into(),
            logical_bytes: status.as_ref().map_or(0., |v| v.logical_bytes as f64),
            allowance_bytes: status.map_or(37_500_000., |v| v.allowance_bytes as f64),
            retained_from_ms: s.entries.keys().map(|(_, _, t)| *t).min(),
        }
    }
    pub fn reset(&self, generation: u32) -> Result<(), DockerServiceError> {
        let (a, coord) = self.context();
        {
            let _g = coord.lock_ok();
            let mut s = self.state.lock_ok();
            s.generation = generation;
            s.generation_floor = generation;
            s.reset_epoch = s.reset_epoch.wrapping_add(1);
            s.entries.clear();
            s.metadata.clear();
            s.observed.clear();
            s.fingerprints.clear();
            s.facts.clear();
            s.metadata_history.clear();
            s.population_facts.clear();
            s.populations.clear();
            s.events.clear();
            s.coverage.clear();
            s.restored_coverage.clear();
            s.restore_retry.clear();
            s.saved_coverage.clear();
            s.first_observed.clear();
            s.pending.clear();
            s.retry.clear();
            s.last_warning.clear();
            s.bytes = 0;
            s.aux_bytes = 0;
            recount_aux(&mut s);
        }
        if let Some(a) = a {
            a.writer.reset_docker(
                self.host,
                self.epoch.load(Ordering::Acquire) + i64::from(generation),
            )?;
        }
        Ok(())
    }
}
fn wall_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}
fn next(s: &mut State) -> i64 {
    s.revision = s.revision.saturating_add(1);
    s.revision
}

#[cfg(test)]
mod tests;
