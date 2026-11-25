//! Delivery of alert events inserted into a Linux agent's mirror (RFC 5.3).

use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::Context;
use serde::{Deserialize, Serialize};
use statglass_remote::{AlertListener, HostClock};
use statglass_schema::lock::LockExt;
use statglass_schema::{Event, HostId, HostRecord};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use super::fire::{AlertSinks, ShellSinks, announce};
use crate::history::History;
use crate::state::AppState;

const FLOORS_FILE: &str = "remote-alert-floors.json";
const FRESH_MS: i64 = 10 * 60 * 1000;
type Floors = BTreeMap<HostId, HostFloors>;

#[derive(Default, Deserialize, Serialize)]
struct HostFloors {
    /// A rebuilt mirror can insert events already delivered from its predecessor.
    mirror_epoch: Uuid,
    source_epochs: BTreeMap<Uuid, i64>,
}

struct FloorState {
    floors: Floors,
    dirty: bool,
}

struct Batch<'a> {
    host: HostId,
    epoch: Uuid,
    mirror_epoch: Uuid,
    events: &'a [Event],
}

enum Decision {
    SetFloor(i64),
    Route(Vec<Action>),
}

enum Action {
    PublishOnly,
    Announce,
    CatchUp,
}

fn decide(batch: &Batch<'_>, now_ms: i64, offset_ms: Option<i64>, floors: &Floors) -> Decision {
    let Some(&floor) = floors
        .get(&batch.host)
        .filter(|host| host.mirror_epoch == batch.mirror_epoch)
        .and_then(|host| host.source_epochs.get(&batch.epoch))
    else {
        return Decision::SetFloor(now_ms);
    };
    let fresh_after = now_ms.saturating_sub(FRESH_MS);
    let offset = offset_ms.unwrap_or_default();
    Decision::Route(
        batch
            .events
            .iter()
            .map(|event| {
                let local_ms = event.ts_ms.saturating_sub(offset);
                if local_ms < floor {
                    Action::PublishOnly
                } else if local_ms < fresh_after {
                    Action::CatchUp
                } else {
                    Action::Announce
                }
            })
            .collect(),
    )
}

pub(super) struct RemoteDelivery {
    path: PathBuf,
    state: Mutex<FloorState>,
}

impl RemoteDelivery {
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

    fn receive(
        &self,
        batch: Batch<'_>,
        now_ms: i64,
        offset_ms: Option<i64>,
        sinks: &impl AlertSinks,
        catch_up: impl FnOnce(&[&Event]),
    ) {
        let decision = {
            let mut state = self.state.lock_ok();
            let decision = decide(&batch, now_ms, offset_ms, &state.floors);
            if let Decision::SetFloor(floor) = decision {
                let host = state.floors.entry(batch.host).or_default();
                if host.mirror_epoch != batch.mirror_epoch {
                    *host = HostFloors {
                        mirror_epoch: batch.mirror_epoch,
                        ..HostFloors::default()
                    };
                }
                host.source_epochs.insert(batch.epoch, floor);
                state.dirty = true;
            }
            if state.dirty {
                match write_floors(&self.path, &state.floors) {
                    Ok(()) => state.dirty = false,
                    Err(error) => tracing::warn!(
                        host = %batch.host, epoch = %batch.epoch, path = %self.path.display(),
                        "saving remote alert floors: {error:#}"
                    ),
                }
            }
            decision
        };

        match decision {
            Decision::SetFloor(_) => {
                for event in batch.events {
                    sinks.publish(event);
                }
            }
            Decision::Route(actions) => {
                let mut late = Vec::new();
                for (event, action) in batch.events.iter().zip(actions) {
                    match action {
                        Action::PublishOnly => sinks.publish(event),
                        Action::Announce => announce(sinks, event),
                        Action::CatchUp => {
                            sinks.publish(event);
                            late.push(event);
                        }
                    }
                }
                if !late.is_empty() {
                    catch_up(&late);
                }
            }
        }
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

pub(crate) fn listener_for_host(
    linux: bool,
    on_batch: impl Fn(Uuid, Vec<Event>) + Send + Sync + 'static,
) -> Option<AlertListener> {
    if linux {
        Some(Arc::new(on_batch))
    } else {
        None
    }
}

pub(crate) fn on_mirrored_alerts(
    app: &AppHandle,
    host: &HostRecord,
    clock: &HostClock,
    history: &History,
    epoch: Uuid,
    events: &[Event],
) {
    let Some(state) = app.try_state::<AppState>() else {
        tracing::warn!(host = %host.id, "the app state is gone; mirrored alerts could not be announced");
        return;
    };
    let now_ms = statglass_engine::wall_ms();
    let offset_ms = clock.now_ms().map(|remote| remote.saturating_sub(now_ms));
    let sinks = ShellSinks::new(app, &state, host.clone());
    let mirror_epoch = match history.read(|reader| Ok(reader.epoch())) {
        Ok(epoch) => epoch,
        Err(error) => {
            tracing::warn!(host = %host.id, %error, "reading the mirror epoch; publishing alerts to Timeline only");
            for event in events {
                sinks.publish(event);
            }
            return;
        }
    };
    state.alerts.remote_delivery.receive(
        Batch {
            host: host.id,
            epoch,
            mirror_epoch,
            events,
        },
        now_ms,
        offset_ms,
        &sinks,
        |late| sinks.catch_up(late),
    );
}

#[cfg(test)]
#[path = "remote_delivery_tests.rs"]
mod tests;
