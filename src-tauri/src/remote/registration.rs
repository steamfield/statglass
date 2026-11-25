//! Install/remove one registered source; generation guards reject old callbacks.
use super::*;
use crate::live::RecentFeed;
use statglass_remote::OpenSshDialer;

struct RemoteRecent(Arc<RemoteSource>);

impl RecentFeed for RemoteRecent {
    fn set_recent_interest(&self, on: bool) {
        self.0.set_recent_interest(on);
    }
}

pub(super) fn register(app: &AppHandle, saved: SavedHost) -> Result<(), CommandError> {
    let state = app.state::<AppState>();
    let id = saved.record.id;
    if id == state.local {
        return Err(CommandError::InvalidArgument {
            message: "This is this Mac".into(),
        });
    }
    let dir = data_dir(app)?.join("mirrors").join(id.to_string());
    std::fs::create_dir_all(&dir).map_err(failure)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).map_err(failure)?;
    }
    let history = Arc::new(History::open(&dir));
    history.register_host(&saved.record);
    let budget_mb = saved.config.mirror_budget_mb;
    let mirror = Arc::new(Mirror::new(history.store(), id, budget_mb));
    let generation = Uuid::new_v4();
    state.remotes.generations.lock_ok().insert(id, generation);
    let handle = app.clone();
    let linux = saved.is_linux();
    // The version this callback last saw; callbacks run on every live frame, so
    // only a change reaches the saved hosts and the disk.
    let known = Mutex::new(saved.last_agent_version.clone());
    let cb = Arc::new(move |s: statglass_remote::ConnectionStatus| {
        let state = handle.state::<AppState>();
        if state.remotes.generations.lock_ok().get(&id) != Some(&generation) {
            return;
        }
        let last = {
            let mut known = known.lock_ok();
            if let Some(version) = &s.remote_version
                && known.as_ref() != Some(version)
            {
                *known = Some(version.clone());
                remember_version(&handle, id, version);
            }
            known.clone()
        };
        if publish_status(&state.remotes, id, generation, s, linux, last) {
            super::progress::emit_changed(&handle);
        }
    });
    let source = RemoteSource::new(
        saved.record.clone(),
        state.local,
        Arc::<OpenSshDialer>::default(),
        saved.endpoint().endpoint(),
        cb,
        Some(mirror.clone()),
    );
    source.set_controller_on_battery(state.host(state.local)?.hub().status().on_battery);
    state
        .live
        .register_recent_source(id, Arc::new(RemoteRecent(source.clone())));
    state.remotes.sources.lock_ok().insert(id, source.clone());
    let entry = state.hosts.insert(saved.record.clone(), source);
    let synced_through_ms = mirror
        .sync_watermark()
        .ok()
        .and_then(|w| w.synced_through())
        .map(|ms| ms as f64);
    state.remotes.mirrors.lock_ok().insert(
        id,
        RegisteredMirror {
            history,
            sink: mirror,
        },
    );
    state.remotes.saved.lock_ok().insert(id, saved.clone());
    state.remotes.statuses.lock_ok().insert(
        id,
        RemoteHostStatus {
            state: if saved.config.enabled {
                RemoteState::Connecting
            } else {
                RemoteState::Disabled
            },
            synced_through_ms,
            agent_update: super::commands::agent_update(
                saved.is_linux(),
                saved.last_agent_version.as_deref(),
                false,
            ),
            agent_version: saved.last_agent_version.clone(),
            ..Default::default()
        },
    );
    let watcher = crate::state::spawn_host_watcher(app.clone(), entry.clone());
    if let Some(old) = state.remotes.watchers.lock_ok().insert(id, watcher) {
        old.abort();
    }
    if saved.config.enabled
        && let Err(error) = entry.start(None)
    {
        discard_host(&state, id);
        return Err(failure(error));
    }
    state.live.replace_host(entry);
    state.emit_hosts_changed(app);
    Ok(())
}

/// Status and rr connection identity change under the same status lock.
fn publish_status(
    manager: &RemoteManager,
    id: HostId,
    generation: Uuid,
    status: statglass_remote::ConnectionStatus,
    linux: bool,
    last: Option<String>,
) -> bool {
    let connected = status.connected;
    let remote_version = status.remote_version.clone();
    let mut next = connection_status(status, linux, last);
    // Re-read durable mirror coverage only on state/sync transitions, and never while
    // holding the `statuses` or `mirrors` mutexes.
    let mirror_sink = {
        let needs_watermark = manager
            .statuses
            .lock_ok()
            .get(&id)
            .is_none_or(|prev| prev.sync != next.sync || prev.state != next.state);
        if needs_watermark {
            manager.mirrors.lock_ok().get(&id).map(|m| m.sink.clone())
        } else {
            None
        }
    };
    let refreshed_watermark = mirror_sink.map(|sink| sink.sync_watermark());

    let mut statuses = manager.statuses.lock_ok();
    // A host removed or re-registered meanwhile keeps its newer status.
    if manager.generations.lock_ok().get(&id) == Some(&generation) {
        let mut previous = statuses.get(&id).cloned().unwrap_or_default();
        manager.apply_update(id, &mut previous);
        manager.apply_rr(id, &mut previous);
        manager.observe_update(id, connected, remote_version.as_deref());
        if connected {
            manager
                .rr_sessions
                .lock_ok()
                .entry(id)
                .or_insert_with(Uuid::new_v4);
        } else {
            manager.clear_rr(id);
        }
        next.synced_through_ms = match refreshed_watermark {
            Some(Ok(w)) => w.synced_through().map(|ms| ms as f64),
            Some(Err(_)) | None => previous.synced_through_ms,
        };
        manager.apply_update(id, &mut next);
        manager.apply_rr(id, &mut next);
        let mut offsets = manager.emitted_clock_offsets.lock_ok();
        let emitted_offset = offsets.entry(id).or_insert(previous.clock_offset_ms);
        let changed = rendered_status_changed(&previous, &next, *emitted_offset);
        if changed {
            *emitted_offset = next.clock_offset_ms;
        }
        statuses.insert(id, next);
        return changed;
    }
    false
}

/// High-frequency facts are refreshed by the host list's five-second poll.
// Keep aligned with CLOCK_STEP_THRESHOLD_MS in packages/core/src/host-clock.ts.
const CLOCK_STEP_THRESHOLD_MS: f64 = 1000.0;

fn rendered_status_changed(
    previous: &RemoteHostStatus,
    next: &RemoteHostStatus,
    emitted_offset: f64,
) -> bool {
    (next.clock_offset_ms - emitted_offset).abs() >= CLOCK_STEP_THRESHOLD_MS
        || previous.sync != next.sync
        || previous.agent_version != next.agent_version
        || previous.state != next.state
        || previous.route != next.route
        || previous.error != next.error
        || previous.failure_kind != next.failure_kind
        || previous.route_failures != next.route_failures
        || previous.next_attempt_ms != next.next_attempt_ms
        || previous.dialing != next.dialing
        || previous.waiting_for_network != next.waiting_for_network
        || previous.synced_through_ms != next.synced_through_ms
        || previous.identity_changed != next.identity_changed
        || previous.agent_update != next.agent_update
        || previous.update != next.update
        || previous.last_update_failure != next.last_update_failure
        || previous.rr != next.rr
}

pub(super) async fn discard_host_async(app: &AppHandle, id: HostId) -> Result<(), CommandError> {
    let app = app.clone();
    tokio::task::spawn_blocking(move || discard_host(&app.state::<AppState>(), id))
        .await
        .map_err(failure)
}

fn discard_host(state: &AppState, id: HostId) {
    state.live.remove_host(id);
    if let Some(watcher) = state.remotes.watchers.lock_ok().remove(&id) {
        watcher.abort();
    }
    state.remotes.generations.lock_ok().remove(&id);
    if let Ok(entry) = state.host(id) {
        entry.stop();
    }
    state.hosts.remove(id);
    state.remotes.sources.lock_ok().remove(&id);
    state.remotes.saved.lock_ok().remove(&id);
    state.remotes.statuses.lock_ok().remove(&id);
    state.remotes.emitted_clock_offsets.lock_ok().remove(&id);
    state.remotes.clear_rr(id);
    state.remotes.updates.lock_ok().remove(&id);
    if let Some(m) = state.remotes.mirrors.lock_ok().remove(&id) {
        m.history.close();
    }
}

/// Persists a newly reported version; unchanged versions write nothing.
fn remember_version(app: &AppHandle, id: HostId, version: &str) {
    let changed = match app.state::<AppState>().remotes.saved.lock_ok().get_mut(&id) {
        Some(h) if h.last_agent_version.as_deref() != Some(version) => {
            h.last_agent_version = Some(version.to_string());
            true
        }
        _ => false,
    };
    if changed && let Err(error) = save(app) {
        tracing::warn!(%error, "could not save the host's reported version");
    }
}

pub(super) fn connection_status(
    s: statglass_remote::ConnectionStatus,
    linux: bool,
    last_version: Option<String>,
) -> RemoteHostStatus {
    let connection = statglass_ipc::status::connection_status(&s);
    let agent_version = s.remote_version.or(last_version);
    RemoteHostStatus {
        agent_update: super::commands::agent_update(
            linux,
            agent_version.as_deref(),
            s.incompatible,
        ),
        state: connection.state,
        route: connection.route,
        last_seen_ms: s.last_seen_ms.map(|m| m as f64),
        synced_through_ms: None,
        error: connection.message,
        failure_kind: connection.failure,
        route_failures: connection.route_failures,
        next_attempt_ms: s.next_attempt_ms.map(|ms| ms as f64),
        attempt: s.attempt,
        dialing: s.dialing,
        waiting_for_network: s.waiting_for_network,
        sync: connection.sync,
        clock_offset_ms: s.clock_offset_ms as f64,
        vitals: HostVitals::default(),
        rr: None,
        update: None,
        last_update_failure: None,
        agent_version,
        identity_changed: s.identity_changed.map(|id| id.to_string()),
    }
}

#[cfg(test)]
mod tests;
