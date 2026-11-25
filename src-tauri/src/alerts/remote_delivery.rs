//! Delivery of alert events inserted into a Linux agent's mirror (RFC 5.3).

use std::collections::{BTreeMap, btree_map::Entry};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::Context;
use serde::{Deserialize, Serialize};
use statglass_remote::{Mirror, MirrorAlertBatch};
use statglass_schema::lock::LockExt;
use statglass_schema::settings::UnitSettings;
use statglass_schema::{AlertCause, Event, EventDetail, HostId, HostRecord};
use tauri::{AppHandle, Runtime};
use uuid::Uuid;

use super::AlertsService;
use super::fire::{AlertOutputs, AlertSinks, ShellSinks, announce};
use crate::history::History;

const FLOORS_FILE: &str = "remote-alert-floors.json";
const FRESH_MS: i64 = 10 * 60 * 1000;
type Floors = BTreeMap<HostId, HostFloors>;

#[derive(Deserialize, Serialize)]
struct HostFloors {
    /// A rebuilt mirror can insert events already delivered from its predecessor.
    mirror_epoch: Uuid,
    floor_ms: i64,
    pending: Vec<LateAlert>,
}

struct FloorState {
    floors: Floors,
    dirty: bool,
}

#[derive(Deserialize, Serialize)]
pub(super) struct LateAlert {
    pub event: Event,
    pub local_ms: i64,
}

struct Batch<'a> {
    host: HostId,
    mirror_epoch: Uuid,
    events: &'a [Event],
    caught_up: bool,
}

enum Action {
    PublishOnly,
    Announce,
    CatchUp,
}

fn decide(events: &[Event], now_ms: i64, offset_ms: i64, floor_ms: i64) -> Vec<(Action, i64)> {
    let fresh_after = now_ms.saturating_sub(FRESH_MS);
    events
        .iter()
        .map(|event| {
            let local_ms = event.ts_ms.saturating_sub(offset_ms);
            let action = if local_ms < floor_ms {
                Action::PublishOnly
            } else if local_ms < fresh_after {
                Action::CatchUp
            } else {
                Action::Announce
            };
            (action, local_ms)
        })
        .collect()
}

fn has_finite_alert_values(event: &Event) -> bool {
    let EventDetail::Alert { cause, .. } = &event.detail else {
        return false;
    };
    match cause {
        AlertCause::ProcessCpu { cpu_pct, .. } => cpu_pct.is_finite(),
        AlertCause::Threshold {
            value, threshold, ..
        } => value.is_finite() && threshold.is_finite(),
        AlertCause::ThermalState { .. }
        | AlertCause::HostOffline { .. }
        | AlertCause::HostBack { .. } => true,
    }
}

pub(crate) struct RemoteDelivery {
    path: PathBuf,
    state: Mutex<FloorState>,
}

impl RemoteDelivery {
    pub(crate) fn forget(&self, host: HostId) {
        let mut state = self.state.lock_ok();
        state.dirty |= state.floors.remove(&host).is_some();
        // If the write fails and the app exits before a retry, the old entry can
        // still be read when this host is paired again.
        self.persist(&mut state);
    }

    pub(super) fn open(dir: &Path) -> Self {
        let path = dir.join(FLOORS_FILE);
        let floors = read_floors(&path).unwrap_or_else(|error| {
            tracing::warn!(path = %path.display(), "loading remote alert floors: {error:#}");
            Floors::new()
        });
        Self {
            path,
            state: Mutex::new(FloorState {
                floors,
                dirty: false,
            }),
        }
    }

    fn register(
        &self,
        host: HostId,
        mirror_epoch: Uuid,
        floor_ms: i64,
        catch_up: impl FnOnce(&[LateAlert]),
    ) {
        let mut state = self.state.lock_ok();
        match state.floors.entry(host) {
            Entry::Vacant(entry) => {
                entry.insert(HostFloors {
                    mirror_epoch,
                    floor_ms,
                    pending: Vec::new(),
                });
                state.dirty = true;
            }
            Entry::Occupied(mut entry) if entry.get().mirror_epoch != mirror_epoch => {
                let floor = entry.get_mut();
                floor.finish_catch_up(catch_up);
                floor.mirror_epoch = mirror_epoch;
                floor.floor_ms = floor_ms;
                state.dirty = true;
            }
            Entry::Occupied(_) => {}
        }
        self.persist(&mut state);
    }

    fn persist(&self, state: &mut FloorState) {
        if state.dirty {
            match write_floors(&self.path, &state.floors) {
                Ok(()) => state.dirty = false,
                // A later batch or registration retries. An exit before a
                // successful write can lose pending events already in the mirror.
                Err(error) => tracing::warn!(
                    path = %self.path.display(), "saving remote alert floors: {error:#}"
                ),
            }
        }
    }

    fn receive(
        &self,
        batch: Batch<'_>,
        now_ms: i64,
        offset_ms: i64,
        sinks: &impl AlertSinks,
        catch_up: impl FnOnce(&[LateAlert]),
    ) {
        let mut state = self.state.lock_ok();
        let Some(floor) = state.floors.get_mut(&batch.host) else {
            return;
        };
        if floor.mirror_epoch != batch.mirror_epoch {
            return;
        }
        let actions = decide(batch.events, now_ms, offset_ms, floor.floor_ms);
        let previous_len = floor.pending.len();
        for (event, (action, local_ms)) in batch.events.iter().zip(&actions) {
            if matches!(action, Action::CatchUp) {
                // JSON cannot round-trip non-finite numbers. Keep a malformed
                // event in the Timeline without making the floor file unreadable.
                if !has_finite_alert_values(event) {
                    tracing::warn!(
                        host = %batch.host,
                        ts_ms = event.ts_ms,
                        "skipping malformed remote alert for catch-up"
                    );
                    continue;
                }
                floor.pending.push(LateAlert {
                    event: event.clone(),
                    local_ms: *local_ms,
                });
            }
        }
        state.dirty |= floor.pending.len() != previous_len;
        self.persist(&mut state);

        for (event, (action, _)) in batch.events.iter().zip(actions) {
            match action {
                Action::PublishOnly | Action::CatchUp => sinks.publish(event),
                Action::Announce => announce(sinks, event),
            }
        }
        if batch.caught_up
            && let Some(floor) = state.floors.get_mut(&batch.host)
            && floor.finish_catch_up(catch_up)
        {
            state.dirty = true;
            self.persist(&mut state);
        }
    }
}

impl HostFloors {
    fn finish_catch_up(&mut self, catch_up: impl FnOnce(&[LateAlert])) -> bool {
        if self.pending.is_empty() {
            return false;
        }
        // Keep the pending group on disk until it has been handed to the sinks.
        // An exit during this handoff can replay the group, and a background send
        // can still be interrupted after the group has been cleared.
        catch_up(&self.pending);
        self.pending.clear();
        true
    }
}

fn read_floors(path: &Path) -> anyhow::Result<Floors> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Floors::new()),
        Err(error) => return Err(error).context("reading the floor file"),
    };
    serde_json::from_slice(&bytes).context("decoding the floor file")
}

fn write_floors(path: &Path, floors: &Floors) -> anyhow::Result<()> {
    let json = serde_json::to_vec(floors).context("encoding the floor file")?;
    let dir = path
        .parent()
        .context("the floor file has no parent directory")?;
    fs::create_dir_all(dir).context("creating the alert state directory")?;
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(statglass_store::PRIVATE_FILE_MODE)
        .open(&temporary)
        .context("creating the temporary floor file")?;
    let result = file
        .write_all(&json)
        .and_then(|()| file.sync_all())
        .context("writing the temporary floor file")
        .and_then(|()| fs::rename(&temporary, path).context("replacing the floor file"));
    if result.is_err()
        && let Err(error) = fs::remove_file(&temporary)
        && error.kind() != io::ErrorKind::NotFound
    {
        tracing::warn!(path = %temporary.display(), %error, "removing the temporary floor file");
    }
    result?;
    fs::File::open(dir)
        .and_then(|dir| dir.sync_all())
        .context("syncing the alert state directory")
}

pub(crate) struct MirrorAlerts<R: Runtime> {
    pub app: AppHandle<R>,
    pub host: HostRecord,
    pub generation: Uuid,
    pub generations: fn(&AppHandle<R>) -> &Mutex<BTreeMap<HostId, Uuid>>,
    pub alerts: fn(&AppHandle<R>) -> &AlertsService,
    pub units: fn(&AppHandle<R>) -> UnitSettings,
    pub clock: Box<dyn Fn() -> (i64, Option<i64>) + Send + Sync>,
    pub outputs: AlertOutputs,
}

pub(crate) fn wire_mirror_alerts<R: Runtime>(
    linux: bool,
    mirror: &Mirror,
    history: Arc<History>,
    controller: MirrorAlerts<R>,
) {
    if !linux {
        return;
    }
    let (registered_at, _) = (controller.clock)();
    let registered_epoch = controller.mirror_epoch(&history);
    if let Some(epoch) = registered_epoch {
        controller
            .delivery()
            .register(controller.host.id, epoch, registered_at, |late| {
                controller.sinks(&history, 0).catch_up(late);
            });
    }
    mirror.set_alert_listener(Arc::new(move |batch| {
        controller.on_mirrored_alerts(&history, batch, registered_at, registered_epoch);
    }));
}

impl<R: Runtime> MirrorAlerts<R> {
    fn delivery(&self) -> &RemoteDelivery {
        &(self.alerts)(&self.app).remote_delivery
    }

    fn mirror_epoch(&self, history: &History) -> Option<Uuid> {
        match history.read(|reader| Ok(reader.epoch())) {
            Ok(epoch) => Some(epoch),
            Err(error) => {
                tracing::warn!(host = %self.host.id, %error, "reading the mirror epoch");
                None
            }
        }
    }

    fn on_mirrored_alerts(
        &self,
        history: &History,
        batch: MirrorAlertBatch,
        registered_at: i64,
        registered_epoch: Option<Uuid>,
    ) {
        let (now_ms, remote_ms) = (self.clock)();
        let offset_ms = remote_ms.map_or(0, |remote| remote.saturating_sub(now_ms));
        let mirror_epoch = self.mirror_epoch(history);
        let sinks = self.sinks(history, offset_ms);
        // Removal invalidates the generation before forgetting the floor. Keep the
        // guard through delivery so a callback cannot recreate a forgotten floor.
        let generations = (self.generations)(&self.app).lock_ok();
        if generations.get(&self.host.id) != Some(&self.generation) {
            return;
        }
        let Some(mirror_epoch) = mirror_epoch else {
            for event in &batch.alerts {
                sinks.publish(event);
            }
            return;
        };
        if registered_epoch != Some(mirror_epoch) {
            let floor = registered_epoch.map_or(registered_at, |_| now_ms);
            self.delivery()
                .register(self.host.id, mirror_epoch, floor, |late| {
                    sinks.catch_up(late)
                });
        }
        self.delivery().receive(
            Batch {
                host: self.host.id,
                mirror_epoch,
                events: &batch.alerts,
                caught_up: batch.caught_up,
            },
            now_ms,
            offset_ms,
            &sinks,
            |late| sinks.catch_up(late),
        );
    }

    fn sinks<'a>(&'a self, history: &'a History, offset_ms: i64) -> ShellSinks<'a, R> {
        ShellSinks {
            app: &self.app,
            alerts: (self.alerts)(&self.app),
            history,
            host: self.host.clone(),
            units: (self.units)(&self.app),
            outputs: self.outputs.clone(),
            offset_ms,
        }
    }
}

#[cfg(test)]
#[path = "remote_delivery_tests.rs"]
mod tests;
