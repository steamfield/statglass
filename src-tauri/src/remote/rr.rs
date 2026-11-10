//! Recent-interest-owned rr polling and host-list publication.
use super::*;
use statglass_remote::rr::{RrJob, group};
use std::{future::Future, time::Duration};
use tokio::sync::watch;

// One-shot SSH disables multiplexing, so each read pays a fresh handshake.
const PERIOD: Duration = Duration::from_secs(60);
const CALL_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone)]
struct Target {
    host: HostId,
    generation: Uuid,
    alias: String,
}

impl RemoteManager {
    pub(super) fn apply_rr(&self, host: HostId, status: &mut RemoteHostStatus) {
        status.rr = if matches!(status.state, RemoteState::Connected) {
            self.rr.lock_ok().get(&host).cloned()
        } else {
            None
        };
    }

    pub(super) fn clear_rr(&self, host: HostId) {
        self.rr_sessions.lock_ok().remove(&host);
        let mut jobs = self.rr.lock_ok();
        if jobs.remove(&host).is_some() {
            group(&mut jobs);
        }
    }

    fn rr_targets(&self) -> Vec<Target> {
        let saved = self.saved.lock_ok().clone();
        let statuses = self.statuses.lock_ok();
        let generations = self.rr_sessions.lock_ok();
        saved
            .iter()
            .filter_map(|(id, saved)| {
                let status = statuses.get(id)?;
                if !saved.config.enabled || !matches!(status.state, RemoteState::Connected) {
                    return None;
                }
                let alias = match status.route {
                    Some(RemoteRoute::Lan) => saved.config.lan.clone(),
                    Some(RemoteRoute::Tailscale) => saved.config.tailscale.clone(),
                    None => None,
                }?;
                Some(Target {
                    host: *id,
                    generation: *generations.get(id)?,
                    alias,
                })
            })
            .collect()
    }

    fn publish_rr(
        &self,
        target: Option<&Target>,
        host: HostId,
        job: Option<RrJob>,
        changed: impl FnOnce(),
    ) {
        let statuses = self.statuses.lock_ok();
        let generations = self.rr_sessions.lock_ok();
        if let Some(target) = target
            && (generations.get(&host) != Some(&target.generation)
                || !statuses
                    .get(&host)
                    .is_some_and(|s| matches!(s.state, RemoteState::Connected)))
        {
            return;
        }
        let mut jobs = self.rr.lock_ok();
        let previous = jobs.clone();
        match job {
            Some(job) => {
                jobs.insert(host, job);
            }
            None => {
                jobs.remove(&host);
            }
        }
        group(&mut jobs);
        let differs = previous != *jobs;
        drop(jobs);
        drop(generations);
        drop(statuses);
        if differs {
            changed();
        }
    }
}

pub(super) fn start(app: &AppHandle, stop: watch::Receiver<bool>) {
    let (tx, interest) = watch::channel(false);
    app.state::<AppState>()
        .live
        .observe_hosts_recent_interest(Arc::new(move |on| {
            tx.send_if_modified(|current| {
                let changed = *current != on;
                *current = on;
                changed
            });
        }));
    let handle = app.clone();
    let local_slots = Arc::new(tokio::sync::Semaphore::new(1));
    let task = tauri::async_runtime::spawn(run(interest, stop, move || {
        let app = handle.clone();
        let local_slots = local_slots.clone();
        async move {
            let state = app.state::<AppState>();
            poll(
                &state.remotes,
                state.local,
                state.remotes.rr_targets(),
                |alias| async move { statglass_remote::rr::read(&alias).await },
                local_read(local_slots, statglass_remote::rr::read_local),
                || super::progress::emit_changed(&app),
            )
            .await;
        }
    }));
    if let Some(old) = app
        .state::<AppState>()
        .remotes
        .rr_task
        .lock_ok()
        .replace(task)
    {
        old.abort();
    }
}

/// A timed-out blocking task retains its permit until the OS read actually ends.
/// Later rounds skip it instead of accumulating blocked workers.
async fn local_read(
    slots: Arc<tokio::sync::Semaphore>,
    read: impl FnOnce() -> Option<RrJob> + Send + 'static,
) -> Result<Option<RrJob>, tokio::task::JoinError> {
    let Ok(permit) = slots.try_acquire_owned() else {
        tracing::debug!("previous local rr read is still running");
        return Ok(None);
    };
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        read()
    })
    .await
}

async fn poll<F, L>(
    manager: &RemoteManager,
    local: HostId,
    targets: Vec<Target>,
    read: impl Fn(String) -> F,
    local_read: L,
    changed: impl Fn(),
) where
    F: Future<Output = statglass_remote::Result<Option<RrJob>>> + Send + 'static,
    L: Future<Output = Result<Option<RrJob>, tokio::task::JoinError>> + Send + 'static,
{
    let mut tasks = tokio::task::JoinSet::new();
    for target in targets {
        let future = read(target.alias.clone());
        tasks.spawn(async move {
            let job = match tokio::time::timeout(CALL_TIMEOUT, future).await {
                Ok(Ok(job)) => job,
                Ok(Err(error)) => {
                    tracing::debug!(%error, "reading remote rr lock");
                    None
                }
                Err(_) => {
                    tracing::debug!("remote rr lock read timed out");
                    None
                }
            };
            (Some(target.clone()), target.host, job)
        });
    }
    tasks.spawn(async move {
        let job = match tokio::time::timeout(CALL_TIMEOUT, local_read).await {
            Ok(Ok(job)) => job,
            Ok(Err(error)) => {
                tracing::warn!(%error, "local rr reader task failed");
                None
            }
            Err(_) => {
                tracing::debug!("local rr lock read timed out");
                None
            }
        };
        (None, local, job)
    });
    while let Some(result) = tasks.join_next().await {
        match result {
            Ok((target, host, job)) => manager.publish_rr(target.as_ref(), host, job, &changed),
            Err(error) => tracing::warn!(%error, "rr reader task failed"),
        }
    }
}

/// Dropping a poll cancels its JoinSet (and kill-on-drop SSH processes).
async fn run<F: Future<Output = ()>>(
    mut interest: watch::Receiver<bool>,
    mut stop: watch::Receiver<bool>,
    mut poll: impl FnMut() -> F,
) {
    loop {
        if *stop.borrow() {
            return;
        }
        if !*interest.borrow_and_update() {
            tokio::select! {
                _ = stop.changed() => return,
                result = interest.changed() => if result.is_err() { return; },
            }
            continue;
        }
        let mut interval = tokio::time::interval(PERIOD);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                biased;
                _ = stop.changed() => return,
                result = interest.changed() => { if result.is_err() { return; } break; },
                _ = interval.tick() => {
                    tokio::select! {
                        biased;
                        _ = stop.changed() => return,
                        result = interest.changed() => { if result.is_err() { return; } break; },
                        () = poll() => {},
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
