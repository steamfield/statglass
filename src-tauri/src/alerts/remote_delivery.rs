//! Delivery of alert events inserted into a Linux agent's mirror (RFC 5.3).

use std::collections::BTreeMap;
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
use statglass_schema::{Event, HostId, HostRecord};
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
}

struct FloorState {
    floors: Floors,
    dirty: bool,
    pending: BTreeMap<HostId, Vec<LateAlert>>,
}

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

fn decide(batch: &Batch<'_>, now_ms: i64, offset_ms: i64, floors: &Floors) -> Vec<(Action, i64)> {
    let floor = floors
        .get(&batch.host)
        .filter(|host| host.mirror_epoch == batch.mirror_epoch)
        .map(|host| host.floor_ms);
    let fresh_after = now_ms.saturating_sub(FRESH_MS);
    batch
        .events
        .iter()
        .map(|event| {
            let local_ms = event.ts_ms.saturating_sub(offset_ms);
            let action = if floor.is_none_or(|floor| local_ms < floor) {
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

pub(crate) struct RemoteDelivery {
    path: PathBuf,
    state: Mutex<FloorState>,
}

impl RemoteDelivery {
    pub(crate) fn forget(&self, host: HostId) {
        let mut state = self.state.lock_ok();
        state.dirty |= state.floors.remove(&host).is_some();
        state.pending.remove(&host);
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
                pending: BTreeMap::new(),
            }),
        }
    }

    fn register(&self, host: HostId, mirror_epoch: Uuid, floor_ms: i64) {
        let mut state = self.state.lock_ok();
        if state
            .floors
            .get(&host)
            .is_none_or(|floor| floor.mirror_epoch != mirror_epoch)
        {
            state.floors.insert(
                host,
                HostFloors {
                    mirror_epoch,
                    floor_ms,
                },
            );
            state.pending.remove(&host);
            state.dirty = true;
        }
        self.persist(&mut state);
    }

    fn persist(&self, state: &mut FloorState) {
        if state.dirty {
            match write_floors(&self.path, &state.floors) {
                Ok(()) => state.dirty = false,
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
        let (actions, late) = {
            let mut state = self.state.lock_ok();
            self.persist(&mut state);
            let actions = decide(&batch, now_ms, offset_ms, &state.floors);
            for (event, (action, local_ms)) in batch.events.iter().zip(&actions) {
                if matches!(action, Action::CatchUp) {
                    state
                        .pending
                        .entry(batch.host)
                        .or_default()
                        .push(LateAlert {
                            event: event.clone(),
                            local_ms: *local_ms,
                        });
                }
            }
            let late = if batch.caught_up {
                state.pending.remove(&batch.host).unwrap_or_default()
            } else {
                Vec::new()
            };
            (actions, late)
        };

        for (event, (action, _)) in batch.events.iter().zip(actions) {
            match action {
                Action::PublishOnly | Action::CatchUp => sinks.publish(event),
                Action::Announce => announce(sinks, event),
            }
        }
        if !late.is_empty() {
            catch_up(&late);
        }
    }
}

fn read_floors(path: &Path) -> anyhow::Result<Floors> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Floors::new()),
        Err(error) => return Err(error).context("reading the floor file"),
    };
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum StoredFloor {
        Current(HostFloors),
        Legacy {
            mirror_epoch: Uuid,
            source_epochs: BTreeMap<Uuid, i64>,
        },
    }
    let stored: BTreeMap<HostId, StoredFloor> =
        serde_json::from_slice(&bytes).context("decoding the floor file")?;
    Ok(stored
        .into_iter()
        .filter_map(|(host, floor)| {
            let floor = match floor {
                StoredFloor::Current(floor) => floor,
                StoredFloor::Legacy {
                    mirror_epoch,
                    source_epochs,
                } => HostFloors {
                    mirror_epoch,
                    floor_ms: source_epochs.into_values().min()?,
                },
            };
            Some((host, floor))
        })
        .collect())
}

fn write_floors(path: &Path, floors: &Floors) -> anyhow::Result<()> {
    let json = serde_json::to_vec(floors).context("encoding the floor file")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).context("creating the alert state directory")?;
    }
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
    result
}

pub(crate) struct MirrorAlerts<R: Runtime> {
    pub app: AppHandle<R>,
    pub host: HostRecord,
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
            .register(controller.host.id, epoch, registered_at);
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
        let alerts = (self.alerts)(&self.app);
        let sinks = ShellSinks {
            app: &self.app,
            alerts,
            history,
            host: self.host.clone(),
            units: (self.units)(&self.app),
            outputs: self.outputs.clone(),
            offset_ms,
        };
        let Some(mirror_epoch) = self.mirror_epoch(history) else {
            for event in &batch.alerts {
                sinks.publish(event);
            }
            return;
        };
        if registered_epoch != Some(mirror_epoch) {
            let floor = registered_epoch.map_or(registered_at, |_| now_ms);
            self.delivery().register(self.host.id, mirror_epoch, floor);
        }
        alerts.remote_delivery.receive(
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
}

#[cfg(test)]
#[path = "remote_delivery_tests.rs"]
mod tests;
