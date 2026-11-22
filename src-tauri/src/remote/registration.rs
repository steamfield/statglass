//! Install/remove one registered source; generation guards reject old callbacks.
use super::*;
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
    let mirror = Arc::new(Mirror::new(
        history.store(),
        id,
        saved.config.mirror_budget_mb,
    ));
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
        saved.endpoint(),
        cb,
        Some(mirror.clone()),
    );
    source.set_controller_on_battery(state.host(state.local)?.hub().status().on_battery);
    state.live.register_recent_source(id, source.clone());
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
// Keep aligned with CLOCK_STEP_THRESHOLD_MS in src/core/host-clock.ts.
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
    let agent_version = s.remote_version.or(last_version);
    RemoteHostStatus {
        agent_update: super::commands::agent_update(
            linux,
            agent_version.as_deref(),
            s.incompatible,
        ),
        state: if s.connected {
            RemoteState::Connected
        } else if s.retrying {
            RemoteState::Connecting
        } else if s.error.is_some() {
            RemoteState::Error
        } else {
            RemoteState::Offline
        },
        route: s.route.map(map_route),
        last_seen_ms: s.last_seen_ms.map(|m| m as f64),
        synced_through_ms: None,
        error: s
            .error
            .or_else(|| s.connected.then_some(s.history_error.clone()).flatten()),
        failure_kind: s.failure_kind.map(map_failure_kind),
        route_failures: s
            .route_failures
            .iter()
            .map(|failure| RemoteRouteFailure {
                route: map_route(failure.route),
                kind: map_failure_kind(failure.kind),
            })
            .collect(),
        sync: if s.history_error.is_some() {
            RemoteSync::Unavailable
        } else if s.catching_up {
            RemoteSync::CatchingUp
        } else if s.connected {
            RemoteSync::Current
        } else {
            RemoteSync::Idle
        },
        clock_offset_ms: s.clock_offset_ms as f64,
        vitals: HostVitals::default(),
        rr: None,
        update: None,
        last_update_failure: None,
        agent_version,
        identity_changed: s.identity_changed.map(|id| id.to_string()),
    }
}

fn map_route(route: statglass_remote::Route) -> RemoteRoute {
    match route {
        statglass_remote::Route::Lan => RemoteRoute::Lan,
        statglass_remote::Route::Tailscale => RemoteRoute::Tailscale,
    }
}

fn map_failure_kind(kind: statglass_remote::ConnectionFailureKind) -> RemoteFailureKind {
    match kind {
        statglass_remote::ConnectionFailureKind::Unreachable => RemoteFailureKind::Unreachable,
        statglass_remote::ConnectionFailureKind::Timeout => RemoteFailureKind::Timeout,
        statglass_remote::ConnectionFailureKind::Authentication => {
            RemoteFailureKind::Authentication
        }
        statglass_remote::ConnectionFailureKind::HostKey => RemoteFailureKind::HostKey,
        statglass_remote::ConnectionFailureKind::AgentNotRunning => {
            RemoteFailureKind::AgentNotRunning
        }
        statglass_remote::ConnectionFailureKind::Incompatible => RemoteFailureKind::Incompatible,
        statglass_remote::ConnectionFailureKind::IdentityChanged => {
            RemoteFailureKind::IdentityChanged
        }
        statglass_remote::ConnectionFailureKind::Protocol => RemoteFailureKind::Protocol,
        statglass_remote::ConnectionFailureKind::NameNotResolved => {
            RemoteFailureKind::NameNotResolved
        }
        statglass_remote::ConnectionFailureKind::Refused => RemoteFailureKind::Refused,
        statglass_remote::ConnectionFailureKind::NoRoute => RemoteFailureKind::NoRoute,
        statglass_remote::ConnectionFailureKind::LocalOffline => RemoteFailureKind::LocalOffline,
        statglass_remote::ConnectionFailureKind::TailscaleDown => RemoteFailureKind::TailscaleDown,
    }
}

#[cfg(test)]
mod tests;
