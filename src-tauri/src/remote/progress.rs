//! Per-host update lifetime and coalesced host-list notifications.
use super::*;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tauri_specta::Event;

const REMOTE_UPDATE_RECONNECT_TIMEOUT: Duration = Duration::from_secs(180);
const REMOTE_HOSTS_EVENT_PERIOD: Duration = Duration::from_millis(250);

pub(super) struct TrackedUpdate {
    pub(super) token: Uuid,
    via: AgentUpdateVia,
    progress: Option<AgentUpdateProgress>,
    failure: Option<AgentUpdateFailure>,
    reconnecting_at: Option<Instant>,
    /// `update --request` may install a release newer than this controller.
    accept_newer: bool,
}

impl TrackedUpdate {
    fn phase(&mut self, phase: UpdatePhase, now: Instant) {
        self.reconnecting_at = matches!(phase, UpdatePhase::Reconnecting).then_some(now);
        if let Some(progress) = &mut self.progress {
            progress.phase = phase;
        }
    }

    fn fail(&mut self, message: String) {
        if let Some(progress) = self.progress.take() {
            self.failure = Some(AgentUpdateFailure {
                target: progress.target,
                via: self.via,
                message,
            });
        }
        self.reconnecting_at = None;
    }

    fn observe(&mut self, connected: bool, version: Option<&str>) {
        if connected
            && self.failure.as_ref().is_some_and(|failure| {
                version.is_some_and(|version| {
                    failure.target == version
                        || super::commands::older_version(&failure.target, version)
                })
            })
        {
            self.failure = None;
        }
        if self.reconnecting_at.is_some()
            && connected
            && self.progress.as_ref().is_some_and(|p| {
                version.is_some_and(|version| {
                    p.target == version
                        || self.accept_newer && super::commands::older_version(&p.target, version)
                })
            })
        {
            self.progress = None;
            self.failure = None;
            self.reconnecting_at = None;
        }
    }

    fn expire(&mut self, now: Instant) {
        if self
            .reconnecting_at
            .is_some_and(|at| now.duration_since(at) >= REMOTE_UPDATE_RECONNECT_TIMEOUT)
        {
            self.fail(
                "The host did not reconnect with the updated agent within three minutes".into(),
            );
        }
    }
}

impl RemoteManager {
    /// Publish queued demand before serializing remote maintenance, and retain errors
    /// from every subsequent step. The caller supplies the SSH/bundle work.
    pub(super) async fn run_update<F: std::future::Future<Output = Result<(), CommandError>>>(
        &self,
        host: HostId,
        target: String,
        via: AgentUpdateVia,
        changed: impl Fn(),
        work: impl FnOnce(Uuid) -> F,
    ) -> Result<(), CommandError> {
        let token = self.begin_update(host, target, via)?;
        changed();
        let _guard = self.operation.lock().await;
        if !self.set_update_phase(host, token, UpdatePhase::Probing) {
            return Err(CommandError::UnknownHost { host });
        }
        changed();
        let result = work(token).await;
        if let Err(error) = &result {
            self.update_failed(host, token, error);
            changed();
        }
        result
    }

    pub(in crate::remote) fn set_update_phase(
        &self,
        host: HostId,
        token: Uuid,
        phase: UpdatePhase,
    ) -> bool {
        let mut updates = self.updates.lock_ok();
        let Some(update) = updates
            .get_mut(&host)
            .filter(|u| u.token == token && u.progress.is_some())
        else {
            return false;
        };
        update.phase(phase, Instant::now());
        true
    }
    pub(super) fn apply_update(&self, host: HostId, status: &mut RemoteHostStatus) {
        if let Some(update) = self.updates.lock_ok().get(&host) {
            status.update = update.progress.clone();
            status.last_update_failure = update.failure.clone();
        }
    }

    pub(super) fn begin_update(
        &self,
        host: HostId,
        target: String,
        via: AgentUpdateVia,
    ) -> Result<Uuid, CommandError> {
        let mut updates = self.updates.lock_ok();
        if updates.get(&host).is_some_and(|u| u.progress.is_some()) {
            return Err(CommandError::RemoteBusy {
                message: "This host is already updating".into(),
            });
        }
        let token = Uuid::new_v4();
        let failure = updates.remove(&host).and_then(|u| u.failure);
        updates.insert(
            host,
            TrackedUpdate {
                token,
                via,
                progress: Some(AgentUpdateProgress {
                    target,
                    phase: UpdatePhase::Queued,
                }),
                failure,
                reconnecting_at: None,
                accept_newer: false,
            },
        );
        Ok(token)
    }

    pub(super) fn accept_newer_update(&self, host: HostId, token: Uuid) {
        if let Some(update) = self
            .updates
            .lock_ok()
            .get_mut(&host)
            .filter(|u| u.token == token)
        {
            update.accept_newer = true;
        }
    }

    pub(super) fn observe_update(&self, host: HostId, connected: bool, version: Option<&str>) {
        if let Some(update) = self.updates.lock_ok().get_mut(&host) {
            update.observe(connected, version);
        }
    }

    pub(super) fn update_failed(&self, host: HostId, token: Uuid, error: &CommandError) {
        if let Some(update) = self
            .updates
            .lock_ok()
            .get_mut(&host)
            .filter(|u| u.token == token)
        {
            update.fail(error.to_string());
        }
    }
}

pub(super) fn emit_changed(app: &AppHandle) {
    if app
        .state::<AppState>()
        .remotes
        .event_pending
        .swap(true, Ordering::AcqRel)
    {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(REMOTE_HOSTS_EVENT_PERIOD).await;
        // Reset before emitting so a racing change schedules the next notification.
        app.state::<AppState>()
            .remotes
            .event_pending
            .store(false, Ordering::Release);
        if let Err(error) = (RemoteHostsChanged {}).emit(&app) {
            tracing::warn!(%error, "notifying remote host changes");
        }
    });
}

pub(super) fn phase(app: &AppHandle, host: HostId, token: Uuid, phase: UpdatePhase) {
    let reconnecting = matches!(phase, UpdatePhase::Reconnecting);
    if !app
        .state::<AppState>()
        .remotes
        .set_update_phase(host, token, phase)
    {
        return;
    }
    emit_changed(app);
    if reconnecting {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(REMOTE_UPDATE_RECONNECT_TIMEOUT).await;
            if let Some(update) = app
                .state::<AppState>()
                .remotes
                .updates
                .lock_ok()
                .get_mut(&host)
                .filter(|u| u.token == token)
            {
                update.expire(Instant::now());
            }
            emit_changed(&app);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn host() -> HostId {
        HostId(Uuid::nil())
    }
    fn status(manager: &RemoteManager) -> RemoteHostStatus {
        let mut status = RemoteHostStatus::default();
        manager.apply_update(host(), &mut status);
        status
    }
    #[test]
    fn a_successful_connection_clears_a_failure_at_or_above_its_target() {
        for via in [AgentUpdateVia::Push, AgentUpdateVia::AddHost] {
            for version in ["1.0.0", "1.1.0"] {
                let manager = RemoteManager::default();
                let token = manager.begin_update(host(), "1.0.0".into(), via).unwrap();
                manager.update_failed(host(), token, &failure("upload failed"));
                manager.observe_update(host(), false, Some(version));
                assert!(status(&manager).last_update_failure.is_some());
                manager.observe_update(host(), true, Some("0.9.0"));
                assert!(status(&manager).last_update_failure.is_some());
                manager.observe_update(host(), true, Some(version));
                assert!(status(&manager).last_update_failure.is_none());
            }
        }
    }

    #[test]
    fn failures_retain_the_update_route_that_started_the_attempt() {
        for via in [AgentUpdateVia::Push, AgentUpdateVia::AddHost] {
            let manager = RemoteManager::default();
            let token = manager.begin_update(host(), "1.0.0".into(), via).unwrap();
            manager.update_failed(host(), token, &failure("upload failed"));
            assert_eq!(status(&manager).last_update_failure.unwrap().via, via);
        }
    }

    #[tokio::test]
    async fn queued_progress_is_visible_while_another_operation_holds_the_lock() {
        let manager = RemoteManager::default();
        let other_host = manager.operation.lock().await;
        let update = manager.run_update(
            host(),
            "1.0.0".into(),
            AgentUpdateVia::Push,
            || {},
            |_| async { Ok(()) },
        );
        tokio::pin!(update);
        tokio::select! {
            result = &mut update => panic!("update skipped the operation lock: {result:?}"),
            () = tokio::task::yield_now() => {
                assert_eq!(status(&manager).update.unwrap().phase, UpdatePhase::Queued);
                assert!(matches!(manager.begin_update(host(), "1.0.0".into(), AgentUpdateVia::Push), Err(CommandError::RemoteBusy { .. })));
            }
        }
        drop(other_host);
        update.await.unwrap();
        assert_eq!(status(&manager).update.unwrap().phase, UpdatePhase::Probing);
    }
    #[test]
    fn progress_clears_only_after_reconnect_with_the_target_version() {
        let manager = RemoteManager::default();
        manager
            .begin_update(host(), "1.0.0".into(), AgentUpdateVia::Push)
            .unwrap();
        manager
            .updates
            .lock_ok()
            .get_mut(&host())
            .unwrap()
            .phase(UpdatePhase::Reconnecting, Instant::now());
        manager.observe_update(host(), false, Some("1.0.0"));
        assert!(status(&manager).update.is_some());
        manager.observe_update(host(), true, Some("0.9.0"));
        assert!(status(&manager).update.is_some());
        manager.observe_update(host(), true, Some("1.1.0"));
        assert!(
            status(&manager).update.is_some(),
            "push updates still require the exact target"
        );
        manager.observe_update(host(), true, Some("1.0.0"));
        assert!(status(&manager).update.is_none());
    }
    #[test]
    fn automatic_updates_accept_a_successfully_installed_newer_release() {
        let manager = RemoteManager::default();
        let token = manager
            .begin_update(host(), "1.0.0".into(), AgentUpdateVia::Push)
            .unwrap();
        manager.accept_newer_update(host(), token);
        manager.set_update_phase(host(), token, UpdatePhase::Reconnecting);
        manager.observe_update(host(), false, Some("1.1.0"));
        assert!(status(&manager).update.is_some());
        manager.observe_update(host(), true, Some("0.9.0"));
        assert!(status(&manager).update.is_some());
        manager.observe_update(host(), true, Some("1.1.0"));
        assert!(
            status(&manager).update.is_none(),
            "an automatic update can install a release newer than the controller"
        );
    }
    #[test]
    fn reconnect_deadline_moves_progress_to_failure_and_success_clears_it() {
        let manager = RemoteManager::default();
        manager
            .begin_update(host(), "1.0.0".into(), AgentUpdateVia::Push)
            .unwrap();
        let now = Instant::now();
        {
            let mut updates = manager.updates.lock_ok();
            let update = updates.get_mut(&host()).unwrap();
            update.phase(UpdatePhase::Reconnecting, now);
            update.expire(now + REMOTE_UPDATE_RECONNECT_TIMEOUT - Duration::from_millis(1));
            assert!(update.progress.is_some());
            update.expire(now + REMOTE_UPDATE_RECONNECT_TIMEOUT);
        }
        let failed = status(&manager);
        assert!(failed.update.is_none());
        assert_eq!(failed.last_update_failure.unwrap().target, "1.0.0");
        manager
            .begin_update(host(), "1.0.0".into(), AgentUpdateVia::Push)
            .unwrap();
        assert!(status(&manager).last_update_failure.is_some());
        manager
            .updates
            .lock_ok()
            .get_mut(&host())
            .unwrap()
            .phase(UpdatePhase::Reconnecting, now);
        manager.observe_update(host(), true, Some("1.0.0"));
        assert!(status(&manager).last_update_failure.is_none());
    }
    #[test]
    fn update_errors_are_retained_and_stale_attempts_cannot_replace_progress() {
        let manager = RemoteManager::default();
        let token = manager
            .begin_update(host(), "1.0.0".into(), AgentUpdateVia::Push)
            .unwrap();
        let error = CommandError::RemoteUnreachable {
            message: "upload interrupted".into(),
        };
        manager.update_failed(host(), token, &error);
        let got = status(&manager);
        assert!(got.update.is_none());
        assert!(
            got.last_update_failure
                .unwrap()
                .message
                .contains("upload interrupted")
        );
        manager
            .begin_update(host(), "1.1.0".into(), AgentUpdateVia::Push)
            .unwrap();
        manager.update_failed(host(), token, &error);
        assert_eq!(status(&manager).update.unwrap().target, "1.1.0");
    }

    #[tokio::test]
    async fn saved_update_work_errors_become_the_hosts_last_failure() {
        let manager = RemoteManager::default();
        let result = manager
            .run_update(
                host(),
                "1.0.0".into(),
                AgentUpdateVia::Push,
                || {},
                |_| async {
                    Err(CommandError::RemoteUnreachable {
                        message: "probe refused".into(),
                    })
                },
            )
            .await;
        assert!(result.is_err());
        let got = status(&manager);
        assert!(got.update.is_none());
        assert!(
            got.last_update_failure
                .unwrap()
                .message
                .contains("probe refused")
        );
    }

    #[tokio::test]
    async fn saved_update_records_push_and_request_phase_order() {
        for upload in [true, false] {
            let manager = &RemoteManager::default();
            let phases = Mutex::new(Vec::new());
            let record = || phases.lock_ok().push(status(manager).update.unwrap().phase);
            manager
                .run_update(
                    host(),
                    "1.0.0".into(),
                    AgentUpdateVia::Push,
                    record,
                    |token| async move {
                        let mut steps = vec![];
                        if upload {
                            steps.push(UpdatePhase::Uploading {
                                sent_bytes: 42,
                                total_bytes: 42,
                            });
                        }
                        steps.extend([
                            UpdatePhase::Installing,
                            UpdatePhase::Restarting,
                            UpdatePhase::Reconnecting,
                        ]);
                        for phase in steps {
                            manager.set_update_phase(host(), token, phase);
                            record();
                        }
                        Ok(())
                    },
                )
                .await
                .unwrap();
            let mut expected = vec![UpdatePhase::Queued, UpdatePhase::Probing];
            if upload {
                expected.push(UpdatePhase::Uploading {
                    sent_bytes: 42,
                    total_bytes: 42,
                });
            }
            expected.extend([
                UpdatePhase::Installing,
                UpdatePhase::Restarting,
                UpdatePhase::Reconnecting,
            ]);
            assert_eq!(*phases.lock_ok(), expected);
        }
    }
}
