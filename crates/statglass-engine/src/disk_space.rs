//! Disk space report lifecycle (plan/disk-space-report.md): one scan at a time, one
//! finished report kept, both in memory only. The shell cancels the scan when the dashboard
//! hides and drops the report when the dashboard is destroyed. A finished boot-volume
//! scan also leaves its largest actionable folders (`SpaceHighlights`) in a small
//! owner-only file, so the Overview can show them without scanning again.
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use statglass_collect::disk_space::{Scan, ScanError, ScanPlan};
use statglass_schema::disk_space::{
    SpaceFile, SpaceHighlights, SpacePhase, SpaceReport, SpaceScanStatus, SpaceSubtree,
    SpaceTarget, SpaceVolume,
};
use statglass_schema::lock::LockExt;

#[derive(Debug, thiserror::Error)]
pub enum SpaceError {
    #[error("a scan is already running")]
    Busy,
    #[error("this report is no longer available; scan again")]
    NotFound,
    #[error("{0}")]
    Scan(#[from] ScanError),
}

struct Entry {
    id: u32,
    scan: Arc<Scan>,
    finished_ms: f64,
}

#[derive(Default)]
struct Inner {
    next_id: u32,
    running: Option<Entry>,
    report: Option<Entry>,
    /// How the last scan that did not produce a report ended.
    ended: Option<(SpacePhase, Option<String>, String)>,
    /// The last boot-volume summary, read from `summary` at start and kept current.
    highlights: Option<SpaceHighlights>,
}

#[derive(Default)]
pub struct SpaceService {
    inner: Mutex<Inner>,
    /// Set by [`SpaceService::folder`]: the one folder this service offers as a volume.
    folder: Option<PathBuf>,
    /// Where the highlights summary is kept, and the user's home folder; none for a
    /// service that keeps no summary (a host answering remote scans).
    summary: Option<(PathBuf, Option<PathBuf>)>,
}

/// Folders a summary keeps; the Overview shows the first five.
const HIGHLIGHTS: usize = 8;
/// The summary's file in the app data directory.
pub const HIGHLIGHTS_FILE: &str = "space-highlights.json";

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

impl SpaceService {
    pub fn new() -> Self {
        Self::default()
    }

    /// A service that keeps the boot volume's highlights in `dir`'s [`HIGHLIGHTS_FILE`],
    /// starting from the summary already there. A missing or unreadable file is no summary.
    pub fn with_summary(dir: &Path, home: Option<PathBuf>) -> Self {
        let path = dir.join(HIGHLIGHTS_FILE);
        let highlights = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .inspect_err(|e| tracing::warn!("{} is invalid ({e}); ignoring it", path.display()))
                .ok(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                tracing::warn!("reading {}: {e}", path.display());
                None
            }
        };
        Self {
            inner: Mutex::new(Inner {
                highlights,
                ..Inner::default()
            }),
            folder: None,
            summary: Some((path, home)),
        }
    }

    /// The last finished boot-volume scan's largest actionable folders.
    pub fn highlights(&self) -> Option<SpaceHighlights> {
        let mut inner = self.inner.lock_ok();
        self.settle(&mut inner);
        inner.highlights.clone()
    }

    /// Whether `path` is one of the summary's folders: the only paths revealed from it.
    pub fn is_highlight(&self, path: &str) -> bool {
        let mut inner = self.inner.lock_ok();
        self.settle(&mut inner);
        inner
            .highlights
            .as_ref()
            .is_some_and(|h| h.folders.iter().any(|f| f.path == path))
    }

    /// Settles a stopped scan; a finished boot-volume scan replaces the summary. Runs
    /// under the service lock once per finished scan; the commands that can reach it
    /// run off the main thread.
    fn settle(&self, inner: &mut Inner) {
        let Some(entry) = settle(inner) else { return };
        let Some((file, home)) = &self.summary else {
            return;
        };
        let plan = entry.scan.plan();
        if !plan.volume.is_boot {
            return;
        }
        let highlights = SpaceHighlights {
            volume: plan.volume.name.clone(),
            finished_ms: entry.finished_ms,
            used_bytes: plan.used_bytes as f64,
            min_bytes: entry.scan.highlight_floor() as f64,
            home: home.as_ref().map(|h| h.to_string_lossy().into_owned()),
            folders: entry.scan.highlights(HIGHLIGHTS),
        };
        if let Err(e) = write_summary(file, &highlights) {
            tracing::warn!("writing {}: {e}", file.display());
        }
        inner.highlights = Some(highlights);
    }

    /// A service whose only volume is `root`, scanned as a volume of its own: for tests
    /// of callers outside this crate, so they never walk the host's disks.
    pub fn folder(root: PathBuf) -> Self {
        Self {
            folder: Some(root),
            ..Self::default()
        }
    }

    /// Volumes the host can scan: what Finder shows on a Mac, local filesystems on Linux.
    pub fn volumes(&self) -> Vec<SpaceVolume> {
        match &self.folder {
            Some(root) => vec![folder_volume(root)],
            None => platform::volumes(),
        }
    }

    pub fn start(&self, mount: &str, include: &[String]) -> Result<SpaceScanStatus, SpaceError> {
        let plan = match &self.folder {
            Some(root) if folder_volume(root).mount == mount => folder_plan(root),
            Some(_) => return Err(ScanError::UnknownVolume(mount.to_owned()).into()),
            None => platform::plan(mount, include)?,
        };
        self.start_plan(plan)
    }

    fn start_plan(&self, plan: ScanPlan) -> Result<SpaceScanStatus, SpaceError> {
        let mut inner = self.inner.lock_ok();
        self.settle(&mut inner);
        if inner.running.is_some() {
            return Err(SpaceError::Busy);
        }
        let volume = plan.volume.mount.clone();
        let scan = match platform::start(plan) {
            Ok(scan) => scan,
            Err(e) => {
                inner.ended = Some((SpacePhase::Failed, Some(e.to_string()), volume));
                return Err(e.into());
            }
        };
        inner.next_id = inner.next_id.wrapping_add(1);
        inner.running = Some(Entry {
            id: inner.next_id,
            scan,
            finished_ms: 0.0,
        });
        inner.ended = None;
        Ok(status_of(&inner))
    }

    pub fn status(&self) -> SpaceScanStatus {
        let mut inner = self.inner.lock_ok();
        self.settle(&mut inner);
        status_of(&inner)
    }

    pub fn cancel(&self) {
        if let Some(entry) = &self.inner.lock_ok().running {
            entry.scan.cancel();
        }
    }

    /// Cancels any scan and forgets the report (the dashboard was destroyed). A scan
    /// that finished unnoticed still leaves its summary.
    pub fn clear(&self) {
        let mut inner = self.inner.lock_ok();
        self.settle(&mut inner);
        if let Some(entry) = inner.running.take() {
            entry.scan.cancel();
        }
        inner.report = None;
        inner.ended = None;
    }

    pub fn report(&self) -> Option<SpaceReport> {
        let mut inner = self.inner.lock_ok();
        self.settle(&mut inner);
        let entry = inner.report.as_ref()?;
        entry.scan.report(entry.id, entry.finished_ms)
    }

    fn with_scan<T>(&self, id: u32, f: impl FnOnce(&Scan) -> Option<T>) -> Result<T, SpaceError> {
        let mut inner = self.inner.lock_ok();
        self.settle(&mut inner);
        let scan = [&inner.running, &inner.report]
            .into_iter()
            .flatten()
            .find(|e| e.id == id)
            .map(|e| Arc::clone(&e.scan))
            .ok_or(SpaceError::NotFound)?;
        drop(inner);
        f(&scan).ok_or(SpaceError::NotFound)
    }

    /// A folder's breakdown in the running scan or the report; `None` is the volume root.
    pub fn subtree(&self, report: u32, node: Option<u32>) -> Result<SpaceSubtree, SpaceError> {
        self.with_scan(report, |scan| scan.subtree(node))
    }

    pub fn largest_files(&self, report: u32) -> Result<Vec<SpaceFile>, SpaceError> {
        self.with_scan(report, |scan| Some(scan.largest_files()))
    }

    pub fn reveal_path(&self, report: u32, target: SpaceTarget) -> Result<PathBuf, SpaceError> {
        self.with_scan(report, |scan| scan.reveal_path(target))
    }
}

/// Moves a scan that has stopped to the report slot (done) or records how it ended.
/// Returns the report when this call moved one there.
fn settle(inner: &mut Inner) -> Option<&Entry> {
    let phase = inner.running.as_ref()?.scan.phase();
    if phase == SpacePhase::Scanning {
        return None;
    }
    let mut entry = inner.running.take()?;
    let volume = entry.scan.plan().volume.mount.clone();
    if phase == SpacePhase::Done && entry.scan.plan().root.exists() {
        entry.finished_ms = now_ms();
        inner.report = Some(entry);
        inner.ended = None;
        return inner.report.as_ref();
    } else if phase == SpacePhase::Done {
        let name = &entry.scan.plan().volume.name;
        let message = format!("Couldn't finish scanning {name}: the volume was disconnected.");
        inner.ended = Some((SpacePhase::Failed, Some(message), volume));
    } else {
        inner.ended = Some((phase, None, volume));
    }
    None
}

fn write_summary(path: &Path, highlights: &SpaceHighlights) -> std::io::Result<()> {
    let json = serde_json::to_vec_pretty(highlights).map_err(std::io::Error::other)?;
    let tmp = path.with_extension("json.tmp");
    statglass_store::write_private(&tmp, &json)?;
    std::fs::rename(&tmp, path)
}

fn status_of(inner: &Inner) -> SpaceScanStatus {
    let idle = SpaceScanStatus {
        phase: SpacePhase::Idle,
        report_id: None,
        volume: None,
        elapsed_ms: 0.0,
        items: 0.0,
        measured_bytes: 0.0,
        used_bytes: 0.0,
        current: None,
        error: None,
    };
    let from = |entry: &Entry| {
        let p = entry.scan.progress();
        SpaceScanStatus {
            phase: p.phase,
            report_id: Some(entry.id),
            volume: Some(entry.scan.plan().volume.mount.clone()),
            elapsed_ms: p.elapsed_ms,
            items: p.items as f64,
            measured_bytes: p.measured as f64,
            used_bytes: entry.scan.plan().used_bytes as f64,
            current: p.current,
            error: None,
        }
    };
    if let Some(entry) = &inner.running {
        return from(entry);
    }
    if let Some((phase, error, volume)) = &inner.ended {
        return SpaceScanStatus {
            phase: *phase,
            volume: Some(volume.clone()),
            error: error.clone(),
            ..idle
        };
    }
    inner.report.as_ref().map_or(idle, from)
}

fn folder_volume(root: &std::path::Path) -> SpaceVolume {
    let mount = root.to_string_lossy().into_owned();
    SpaceVolume {
        name: mount.clone(),
        mount,
        is_boot: false,
        used_bytes: 0.0,
        total_bytes: 0.0,
        protected: Vec::new(),
    }
}

fn folder_plan(root: &std::path::Path) -> ScanPlan {
    ScanPlan {
        volume: folder_volume(root),
        root: root.to_path_buf(),
        skip: Default::default(),
        devices: Vec::new(),
        skipped: Vec::new(),
        siblings: Vec::new(),
        used_bytes: 0,
        firmlinked: Vec::new(),
        threads: 1,
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use statglass_collect::macos::space::{self, BulkLister};

    pub fn volumes() -> Vec<SpaceVolume> {
        space::volumes()
    }
    pub fn plan(mount: &str, include: &[String]) -> Result<ScanPlan, ScanError> {
        space::plan(mount, include)
    }
    pub fn start(plan: ScanPlan) -> Result<Arc<Scan>, ScanError> {
        Scan::start(plan, BulkLister::for_this_thread, || {})
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use statglass_collect::disk_space::StdLister;
    use statglass_collect::linux::space;

    pub fn volumes() -> Vec<SpaceVolume> {
        space::volumes()
    }
    pub fn plan(mount: &str, include: &[String]) -> Result<ScanPlan, ScanError> {
        space::plan(mount, include)
    }
    /// Enters the btrfs subvolumes mounted below the root (`linux::space`).
    pub fn start(plan: ScanPlan) -> Result<Arc<Scan>, ScanError> {
        let devices = plan.devices.clone();
        let lister = move || StdLister {
            devices: devices.clone(),
        };
        Scan::start(plan, lister, || {})
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod platform {
    use super::*;
    use statglass_collect::disk_space::StdLister;

    pub fn volumes() -> Vec<SpaceVolume> {
        Vec::new()
    }
    pub fn plan(mount: &str, _include: &[String]) -> Result<ScanPlan, ScanError> {
        Err(ScanError::UnknownVolume(mount.to_owned()))
    }
    pub fn start(plan: ScanPlan) -> Result<Arc<Scan>, ScanError> {
        Scan::start(plan, StdLister::default, || {})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::time::{Duration, Instant};

    fn plan(root: &std::path::Path) -> ScanPlan {
        ScanPlan {
            volume: SpaceVolume {
                mount: "/test".into(),
                name: "Test".into(),
                is_boot: false,
                used_bytes: 0.0,
                total_bytes: 0.0,
                protected: Vec::new(),
            },
            root: root.to_path_buf(),
            skip: HashSet::new(),
            devices: Vec::new(),
            skipped: Vec::new(),
            siblings: Vec::new(),
            used_bytes: 1 << 30,
            firmlinked: Vec::new(),
            threads: 2,
        }
    }

    fn wait(service: &SpaceService, phase: SpacePhase) -> SpaceScanStatus {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let status = service.status();
            if status.phase == phase || Instant::now() > deadline {
                return status;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn tree(files: usize) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..files {
            let path = dir.path().join(format!("d{}/e{i}/f.bin", i % 7));
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, vec![1u8; 5000]).unwrap();
        }
        dir
    }

    #[test]
    fn a_finished_scan_becomes_the_report() {
        let dir = tree(20);
        let service = SpaceService::new();
        let started = service.start_plan(plan(dir.path())).unwrap();
        let id = started.report_id.unwrap();
        let done = wait(&service, SpacePhase::Done);
        assert_eq!(done.phase, SpacePhase::Done);
        assert_eq!(done.items, 20.0);
        let report = service.report().unwrap();
        assert_eq!(report.id, id);
        assert!(report.finished_ms > 0.0);
        let root = service.subtree(id, None).unwrap();
        assert_eq!(
            root.children
                .iter()
                .filter(|c| c.name.starts_with('d'))
                .count(),
            7
        );
        assert!(matches!(
            service.subtree(id + 1, None),
            Err(SpaceError::NotFound)
        ));
    }

    #[test]
    fn one_scan_at_a_time_and_cancel_keeps_the_previous_report() {
        let dir = tree(20);
        let service = SpaceService::new();
        let first = service.start_plan(plan(dir.path())).unwrap().report_id;
        wait(&service, SpacePhase::Done);
        let big = tree(3000);
        let second = service.start_plan(plan(big.path())).unwrap();
        assert!(matches!(
            service.start_plan(plan(dir.path())),
            Err(SpaceError::Busy)
        ));
        service.cancel();
        let ended = wait(&service, SpacePhase::Cancelled);
        assert_eq!(ended.phase, SpacePhase::Cancelled);
        assert_ne!(second.report_id, first);
        assert_eq!(service.report().map(|r| Some(r.id)), Some(first));
        service.clear();
        assert!(service.report().is_none());
        assert_eq!(service.status().phase, SpacePhase::Idle);
    }

    #[test]
    fn a_vanished_root_fails_the_scan() {
        let dir = tree(5);
        let root = dir.path().join("gone");
        std::fs::create_dir(&root).unwrap();
        let service = SpaceService::new();
        service.start_plan(plan(&root)).unwrap();
        std::fs::remove_dir(&root).unwrap();
        let status = wait(&service, SpacePhase::Failed);
        assert_eq!(status.phase, SpacePhase::Failed);
        assert!(status.error.unwrap().contains("disconnected"));
        assert!(service.report().is_none());
    }

    fn boot(dir: &std::path::Path) -> ScanPlan {
        let mut boot = plan(dir);
        boot.volume.is_boot = true;
        boot
    }

    #[test]
    fn a_finished_boot_scan_leaves_a_summary_the_next_service_reads() {
        // The ranking itself is tested with the tree (`statglass-collect`); here the
        // folders are under its 1 GiB floor, so the summary lists none.
        let dir = tree(20);
        let data = tempfile::tempdir().unwrap();
        let home = Some(PathBuf::from("/Users/me"));
        let service = SpaceService::with_summary(data.path(), home.clone());
        assert!(service.highlights().is_none());
        service.start_plan(boot(dir.path())).unwrap();
        wait(&service, SpacePhase::Done);
        let summary = service.highlights().unwrap();
        assert_eq!(summary.volume, "Test");
        assert!(summary.finished_ms > 0.0);
        assert_eq!(summary.min_bytes, (1u64 << 30) as f64);
        assert_eq!(summary.home.as_deref(), Some("/Users/me"));
        assert!(summary.folders.is_empty());
        service.clear();
        assert_eq!(
            SpaceService::with_summary(data.path(), home).highlights(),
            Some(summary),
            "the summary outlives the report and the process"
        );
    }

    #[test]
    fn only_paths_in_the_kept_summary_are_highlights() {
        let data = tempfile::tempdir().unwrap();
        let kept = SpaceHighlights {
            volume: "Macintosh HD".into(),
            finished_ms: 1.0,
            used_bytes: 4e11,
            min_bytes: 2e9,
            home: None,
            folders: vec![statglass_schema::disk_space::SpaceHighlight {
                path: "/Users/me/Library/Caches".into(),
                bytes: 2e10,
                category: Some(statglass_schema::disk_space::SpaceCategory::Caches),
            }],
        };
        write_summary(&data.path().join(HIGHLIGHTS_FILE), &kept).unwrap();
        let service = SpaceService::with_summary(data.path(), None);
        assert_eq!(service.highlights(), Some(kept));
        assert!(service.is_highlight("/Users/me/Library/Caches"));
        assert!(!service.is_highlight("/Users/me/Library"));
        assert!(!service.is_highlight("/etc/passwd"));
    }

    #[test]
    fn clearing_keeps_the_summary_of_a_scan_nothing_settled() {
        let dir = tree(5);
        let data = tempfile::tempdir().unwrap();
        let service = SpaceService::with_summary(data.path(), None);
        service.start_plan(boot(dir.path())).unwrap();
        // Wait on the scan itself: `status()` would settle it.
        let deadline = Instant::now() + Duration::from_secs(30);
        while service
            .inner
            .lock_ok()
            .running
            .as_ref()
            .is_some_and(|e| e.scan.phase() == SpacePhase::Scanning)
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(5));
        }
        service.clear();
        assert!(service.highlights().is_some());
    }

    #[test]
    fn other_volumes_and_services_without_a_summary_keep_none() {
        let data = tempfile::tempdir().unwrap();
        let dir = tree(5);
        let service = SpaceService::with_summary(data.path(), None);
        service.start_plan(plan(dir.path())).unwrap();
        wait(&service, SpacePhase::Done);
        assert!(service.highlights().is_none());
        assert!(!data.path().join(HIGHLIGHTS_FILE).exists());
        let remote = SpaceService::new();
        remote.start_plan(boot(dir.path())).unwrap();
        wait(&remote, SpacePhase::Done);
        assert!(remote.highlights().is_none());
    }
}
