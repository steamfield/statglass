//! Backgrounding interrupts network work and waits for the mirror's current write.
use super::{
    Candidate, ConnectionStatus, ControlState, RemoteSource, Session, SessionAction, StatusCallback,
};
use crate::{BoxFuture, MirrorError, RemoteError, Result};
use statglass_proto::Message;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::Instant;

impl RemoteSource {
    /// Lets an ingest already running commit, then closes the session and parks until
    /// [`resume`](Self::resume). Dropping the returned future leaves the request in effect.
    pub fn quiesce(&self) -> BoxFuture<'static, ()> {
        let mut parked = self.parked.subscribe();
        let mut requested = 0;
        self.control.send_if_modified(|state| {
            let changed = !state.backgrounded;
            if changed {
                state.backgrounded = true;
                state.quiesce += 1;
            }
            requested = state.quiesce;
            changed
        });
        Box::pin(async move {
            let _ = parked
                .wait_for(|ack| ack.is_none_or(|ack| ack >= requested))
                .await;
        })
    }

    /// Wakes a quiesced source and dials at once with the backoff reset.
    pub fn resume(&self) {
        self.control.send_if_modified(|state| {
            if !state.backgrounded {
                return false;
            }
            state.backgrounded = false;
            state.resumed = state.resumed.wrapping_add(1);
            state.retry = state.retry.wrapping_add(1);
            true
        });
    }
}

impl ControlState {
    pub(super) fn interrupts(&self, before: &Self) -> bool {
        self.stop || self.asleep || self.quiesce != before.quiesce
    }

    pub(super) fn retry_requested_since(&self, before: &Self) -> bool {
        self.retry != before.retry || self.resumed != before.resumed
    }
}

/// The latest background request the runner has finished. Blocking writes hold a
/// reference so a concurrent stop cannot acknowledge a quiesce before they finish.
pub(super) struct ActiveRun(watch::Sender<Option<u64>>);

impl ActiveRun {
    pub(super) fn new(parked: watch::Sender<Option<u64>>) -> Arc<Self> {
        parked.send_replace(Some(0));
        Arc::new(Self(parked))
    }

    pub(super) fn acknowledge(&self, requested: u64) {
        self.0.send_replace(Some(requested));
    }
}

impl Drop for ActiveRun {
    fn drop(&mut self) {
        self.0.send_replace(None);
    }
}

pub(super) struct RunStatus<'a> {
    pub(super) status: ConnectionStatus,
    notify: &'a StatusCallback,
}

impl<'a> RunStatus<'a> {
    pub(super) fn new(notify: &'a StatusCallback) -> Self {
        Self {
            status: ConnectionStatus::default(),
            notify,
        }
    }
}

impl Drop for RunStatus<'_> {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            self.status.record_stopped();
            (self.notify)(std::mem::take(&mut self.status));
        }
    }
}

#[derive(Default)]
pub(super) struct MirrorWrite {
    active: Option<Arc<ActiveRun>>,
    pending: Option<(MirrorWork, tokio::task::JoinHandle<WriteResult>)>,
}

#[derive(Clone, Copy)]
pub(super) enum MirrorWork {
    Page { more: bool, requested: Instant },
    Recent,
    Truncated,
    Prune,
    Read,
}

pub(super) type WriteResult = std::result::Result<(), MirrorError>;

impl MirrorWrite {
    pub(super) fn new(active: Option<Arc<ActiveRun>>) -> Self {
        Self {
            active,
            pending: None,
        }
    }

    pub(super) fn running(&self) -> bool {
        self.pending.is_some()
    }

    pub(super) fn start(
        &mut self,
        work: MirrorWork,
        write: impl FnOnce() -> WriteResult + Send + 'static,
    ) {
        let active = self.active.clone();
        let task = tokio::task::spawn_blocking(move || {
            let _active = active;
            write()
        });
        self.pending = Some((work, task));
    }

    /// Tracks cursor reads through quiesce because they can also change the mirror epoch.
    pub(super) async fn read<T: Send + 'static>(
        &mut self,
        read: impl FnOnce() -> std::result::Result<T, MirrorError> + Send + 'static,
    ) -> Result<std::result::Result<T, MirrorError>> {
        let (send, received) = oneshot::channel();
        self.start(MirrorWork::Read, move || {
            let value = read()?;
            let _ = send.send(value);
            Ok(())
        });
        if let (_, Err(error)) = self.finish().await? {
            return Ok(Err(error));
        }
        received.await.map(Ok).map_err(|error| {
            RemoteError::Transport(format!("receiving remote mirror read: {error}"))
        })
    }

    pub(super) async fn finish(&mut self) -> Result<(MirrorWork, WriteResult)> {
        let Some((work, task)) = self.pending.as_mut() else {
            return std::future::pending().await;
        };
        let work = *work;
        let result = task.await;
        self.pending = None;
        let result = result.map_err(|error| {
            RemoteError::Transport(format!("joining remote mirror write: {error}"))
        })?;
        Ok((work, result))
    }

    pub(super) async fn finish_interrupted(&mut self, status: &mut ConnectionStatus) {
        // Dropping the select branch cancels the await, but the write must finish
        // before parking or starting another session with the same mirror.
        if self.running() {
            match self.finish().await {
                Ok((_, Ok(()))) => {}
                Ok((_, Err(error))) => status.history_error = Some(error.to_string()),
                Err(error) => status.history_error = Some(error.to_string()),
            }
        }
    }
}

impl Session<'_> {
    pub(super) async fn run_until_interrupted(
        &mut self,
        initial: ControlState,
        before: &ControlState,
        messages: mpsc::Receiver<Result<Message>>,
        calls: mpsc::Receiver<crate::calls::Call>,
    ) -> Result<Option<Candidate>> {
        let mut stopping = self.source.control.subscribe();
        let route = self.route;
        tokio::select! {
            biased;
            _ = stopping.wait_for(|state| state.interrupts(before) || state.route_lost(before, route)) => Ok(None),
            result = self.drive(initial, messages, calls) => result,
        }
    }

    async fn drive(
        &mut self,
        initial: ControlState,
        mut messages: mpsc::Receiver<Result<Message>>,
        mut calls: mpsc::Receiver<crate::calls::Call>,
    ) -> Result<Option<Candidate>> {
        self.write(&Message::Interest(initial.interest)).await?;
        self.send_heartbeat().await?;
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(1));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            let action = if self.control.has_changed().unwrap_or(false)
                || self.control.borrow().network != self.network
                || self.control.borrow().retry != self.retry
            {
                self.control_changed().await?
            } else {
                let probing = self.route_watch.probing();
                // Leave the reader free to accept the probe's Pong even if normal
                // writes would stall on this path.
                if !probing {
                    if let Some(interest) = self.pending_interest.take() {
                        self.write(&Message::Interest(interest)).await?;
                    }
                    self.apply_sync_policy();
                    if self.recent_first() {
                        self.request_recent().await?;
                    }
                    if self.request_sync().await? {
                        continue;
                    }
                }
                tokio::select! {
                    biased;
                    _ = self.control.changed() => self.control_changed().await?,
                    action = self.route_watch.next_action() => action,
                    result = self.mirror_write.finish() => {
                        let (work, result) = result?;
                        self.mirror_write_finished(work, result).await?;
                        SessionAction::Continue
                    },
                    _ = timer.tick() => self.tick().await?,
                    incoming = messages.recv() => self.incoming(incoming).await?,
                    Some(call) = calls.recv(), if !probing => self.call(call).await?,
                }
            };
            match action {
                SessionAction::Continue => {}
                SessionAction::Stop => return Ok(None),
                SessionAction::Replace(session) => {
                    return Ok(Some(Candidate {
                        session: *session,
                        network: self.network,
                    }));
                }
            }
        }
    }
}
