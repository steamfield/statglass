//! Connection, retry, idle and connected-session lifecycle.
use super::*;
impl DockerHandle {
    /// Runs the Docker worker until shutdown: connects to the selected engine, samples
    /// it while connected, and backs off between failed attempts.
    pub async fn run(self) {
        let mut controls = self.control.subscribe();
        let mut retry = FIRST_RETRY_SECONDS;
        loop {
            let c = controls.borrow_and_update().clone();
            if c.shutdown {
                break;
            }
            if !c.settings.enabled || c.paused {
                if !self.transition(
                    c.generation,
                    if c.paused {
                        DockerStatus::Paused
                    } else {
                        DockerStatus::Disabled
                    },
                    None,
                    if c.paused { "paused" } else { "disabled" },
                ) {
                    continue;
                }
                if controls.changed().await.is_err() {
                    break;
                }
                continue;
            }
            let generation = c.generation;
            let result = tokio::select! {biased;_=controls.changed()=>continue,result=self.connect_selected(&c.settings)=>result};
            let adapter = match result {
                Ok(a) => a,
                Err(failure) => {
                    self.connect_failed(&mut controls, &c, failure, &mut retry)
                        .await;
                    continue;
                }
            };
            if !self.attach_adapter(&adapter, generation) {
                continue;
            }
            let idle_adapter = adapter.clone();
            let session = self
                .session(adapter, generation, &mut controls, &mut retry)
                .await;
            self.cancel();
            if session == SessionEnd::Disconnected {
                let message = "Docker stream disconnected; retrying".to_owned();
                self.back_off_unavailable(&mut controls, &c, (message, None), &mut retry)
                    .await;
            }
            if session == SessionEnd::Idle {
                if !self.transition(
                    generation,
                    DockerStatus::IdleSuspended,
                    Some("No running containers. Monitoring paused to save power.".into()),
                    "idle_suspended",
                ) {
                    continue;
                }
                if !self
                    .wait_idle(&idle_adapter, generation, &mut controls)
                    .await
                {
                    return;
                }
            }
        }
    }
    /// Reports a failed connection attempt, then waits out the retry delay.
    /// Permission and API-version failures keep their own statuses; anything else is
    /// `Unavailable` with the reason attached, classified from the engines the attempt
    /// probed.
    async fn connect_failed(
        &self,
        controls: &mut watch::Receiver<Control>,
        control: &Control,
        ConnectFailure { error, probed }: ConnectFailure,
        retry: &mut u64,
    ) {
        let status = match error {
            DockerError::Incompatible => DockerStatus::Incompatible,
            DockerError::PermissionDenied => DockerStatus::PermissionDenied,
            _ => {
                let failure = (error.to_string(), probed);
                return self
                    .back_off_unavailable(controls, control, failure, retry)
                    .await;
            }
        };
        let generation = control.generation;
        if !self.transition(generation, status, Some(error.to_string()), "disconnected") {
            return;
        }
        let plan = self.next_retry(*retry);
        *retry = plan.next_seconds;
        self.wait_retry(controls, generation, plan.delay).await;
    }
    /// Publishes `Unavailable` with why and when the next attempt comes, then waits
    /// until then. `failure` is the message and the engines the attempt probed, if any.
    /// Returns early if the generation moves on or the worker shuts down while
    /// discovery runs; visibility and interval changes don't interrupt it.
    async fn back_off_unavailable(
        &self,
        controls: &mut watch::Receiver<Control>,
        control: &Control,
        (message, probed): (String, Option<Vec<DockerEngine>>),
        retry: &mut u64,
    ) {
        let generation = control.generation;
        let plan = self.next_retry(*retry);
        let probe = self.availability(&control.settings, plan.delay, probed);
        tokio::pin!(probe);
        let availability = loop {
            tokio::select! {biased;
                changed = controls.changed() => {
                    if superseded(changed, controls, generation) { return; }
                }
                availability = &mut probe => break availability,
            }
        };
        if !self.transition_unavailable(generation, message, availability) {
            return;
        }
        *retry = plan.next_seconds;
        self.wait_retry(controls, generation, plan.delay).await;
    }
    async fn wait_retry(
        &self,
        controls: &mut watch::Receiver<Control>,
        generation: u32,
        delay: Duration,
    ) {
        let delay = tokio::time::sleep(delay);
        tokio::pin!(delay);
        loop {
            tokio::select! {biased;
                changed = controls.changed() => {
                    if superseded(changed, controls, generation) { return; }
                }
                _ = &mut delay => return,
            }
        }
    }
    /// Connects to the selected engine, found among the candidates without probing
    /// them, or with none selected to the one `unselected_choice` picks after probing
    /// every candidate. A failure carries those probed engines.
    async fn connect_selected(&self, s: &DockerSettings) -> Result<DockerAdapter, ConnectFailure> {
        let (chosen, probed) = if let Some(socket) = &s.selected_engine {
            let list = self.discover_candidates().await;
            let chosen = list
                .into_iter()
                .find(|e| e.socket == *socket)
                .unwrap_or_else(|| DockerEngine {
                    id: socket.clone(),
                    socket: socket.clone(),
                    runtime: "Local Docker (unverified)".into(),
                    context: None,
                    daemon_id: None,
                    reachable: false,
                    preferred: false,
                    error: None,
                    api_version: None,
                    capacity_bytes: None,
                    capacity_observed_ms: None,
                });
            (Some(chosen), None)
        } else {
            let probed = self.discover().await;
            (unselected_choice(&probed), Some(probed))
        };
        let connected = match chosen {
            Some(engine) => DockerAdapter::connect(engine).await,
            None => Err(DockerError::Unavailable),
        };
        connected.map_err(|error| ConnectFailure { error, probed })
    }
    pub(super) async fn discover_candidates(&self) -> Vec<DockerEngine> {
        let home = self.home.clone();
        tokio::task::spawn_blocking(move || candidates(&home))
            .await
            .unwrap_or_default()
    }
    async fn session(
        &self,
        mut adapter: DockerAdapter,
        generation: u32,
        controls: &mut watch::Receiver<Control>,
        retry: &mut u64,
    ) -> SessionEnd {
        let mut healthy_since = None;
        let mut inventory = Inventory::new(self.snapshot().population_revision);
        let mut samples = Samples::new();
        let since = self.event_since(&adapter.engine.id).await;
        // Docker retains only 256 replay events: reconnect cannot prove complete coverage.
        self.gap_for(generation, "event_replay_uncertain");
        let mut events = Box::pin(adapter.events_since(since));
        let mut event_live = true;
        let mut refresh = true;
        let mut event_rate = (Instant::now(), 0usize);
        let mut restarts: BTreeMap<String, VecDeque<i64>> = BTreeMap::new();
        let mut last_observation: Option<Instant> = None;
        loop {
            let control = controls.borrow_and_update().clone();
            if control.generation != generation || control.shutdown {
                return SessionEnd::Changed;
            }
            let interval =
                control
                    .min_interval_ms
                    .max(if control.visible > 0 { 1000 } else { 10000 });
            self.check_clock(crate::clock::now(), &mut samples, generation);
            let cycle_start = Instant::now();
            let mut event_refresh = false;
            let (listed, failed) = {
                let cycle = self.cycle(
                    &mut adapter,
                    &mut inventory,
                    &mut samples,
                    refresh,
                    generation,
                );
                tokio::pin!(cycle);
                loop {
                    tokio::select! {biased;
                        _=controls.changed()=>{if controls.borrow().generation!=generation{return SessionEnd::Changed;}},
                        result=&mut cycle=>break result,
                        event=events.next(),if event_live=>{match event{Some(Ok(e))=>{if admit_event(&mut event_rate){self.record_event(e,&mut restarts,generation);event_refresh=true;}else{event_live=false;self.gap_for(generation,"events_dropped_rate_limit");}},_=>{event_live=false;self.gap_for(generation,"events_disconnected");}}}
                    }
                }
            };
            refresh = event_refresh;
            let ok = listed && failed.is_empty();
            if ok && event_live {
                if healthy_since.get_or_insert_with(Instant::now).elapsed()
                    >= Duration::from_secs(60)
                {
                    *retry = 1;
                }
            } else {
                healthy_since = None;
            }
            if inventory.rows.is_empty()
                && inventory.refreshed_at.elapsed() > Duration::from_secs(30)
            {
                return SessionEnd::Disconnected;
            }
            self.publish_cycle(
                &adapter,
                &control,
                &mut inventory,
                &mut restarts,
                &mut last_observation,
                (listed, &failed),
            );
            if !inventory
                .rows
                .iter()
                .any(|c| c.lifecycle == DockerLifecycle::Running)
            {
                return SessionEnd::Idle;
            }
            let sleep = tokio::time::sleep(
                Duration::from_millis(interval as u64).saturating_sub(cycle_start.elapsed()),
            );
            tokio::pin!(sleep);
            loop {
                tokio::select! {biased;
                    _=controls.changed()=>{if controls.borrow().generation!=generation{return SessionEnd::Changed;}break;},
                    event=events.next(),if event_live=>{match event{Some(Ok(e))=>{if admit_event(&mut event_rate){self.record_event(e,&mut restarts,generation);}else{event_live=false;self.gap_for(generation,"events_dropped_rate_limit");}refresh=true;},_=>{self.gap_for(generation,"events_disconnected");event_live=false;}}},
                    _=&mut sleep=>break
                }
            }
            if !event_live {
                return SessionEnd::Disconnected;
            }
        }
    }
}

impl DockerHandle {
    /// Moves to `status` with `availability` cleared, unless the generation moved on.
    /// Returns whether the transition applied.
    pub(super) fn transition(
        &self,
        generation: u32,
        status: DockerStatus,
        message: Option<String>,
        reason: &str,
    ) -> bool {
        self.apply_transition(generation, status, None, message, reason)
    }
    /// Publishes a status and its availability in one update and opens a `reason` gap.
    pub(super) fn apply_transition(
        &self,
        generation: u32,
        status: DockerStatus,
        availability: Option<DockerAvailability>,
        message: Option<String>,
        reason: &str,
    ) -> bool {
        let _gate = self.gate.lock_ok();
        if self.control.borrow().generation != generation {
            return false;
        }
        self.update(|s| {
            s.now_ms = now_ms();
            s.status = status;
            s.message = message;
            s.generation = generation;
            s.availability = availability;
        });
        self.gap(reason);
        true
    }
    fn gap_for(&self, generation: u32, reason: &str) {
        let _gate = self.gate.lock_ok();
        if self.control.borrow().generation == generation {
            self.gap(reason);
        }
    }
    fn attach_adapter(&self, adapter: &DockerAdapter, generation: u32) -> bool {
        let _gate = self.gate.lock_ok();
        if self.control.borrow().generation != generation {
            return false;
        }
        self.inner.lock_ok().adapter = Some(adapter.clone());
        self.was_connected
            .store(true, std::sync::atomic::Ordering::SeqCst);
        *self.launch.lock_ok() = None;
        self.update(|s| {
            s.now_ms = now_ms();
            if s.engine.as_ref().is_none_or(|e| e.id != adapter.engine.id) {
                s.coverage.clear();
                s.containers.clear();
                s.project_aggregates.clear();
                s.aggregate = DockerAggregate {
                    monitoring_limit: 128,
                    ..Default::default()
                };
            }
            s.engine = Some(adapter.engine.clone());
            s.generation = generation;
            s.availability = None;
        });

        true
    }

    async fn wait_idle(
        &self,
        idle_adapter: &DockerAdapter,
        generation: u32,
        controls: &mut watch::Receiver<Control>,
    ) -> bool {
        let mut visible = controls.borrow().visible;
        let mut probe = tokio::time::interval_at(
            Instant::now() + Duration::from_secs(60),
            Duration::from_secs(60),
        );
        probe.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        'idle: loop {
            tokio::select! { biased;
                changed = controls.changed() => {
                    if changed.is_err() { return false; }
                    let next = controls.borrow_and_update().clone();
                    if next.generation != generation || next.shutdown
                        || next.visible > visible {
                        break;
                    }
                    visible = next.visible;
                }
                _ = probe.tick() => {
                    let result = tokio::select! { biased;
                        changed = controls.changed() => {
                            if changed.is_err() { return false; }
                            let next = controls.borrow_and_update().clone();
                            if next.generation != generation || next.shutdown
                                || next.visible > visible {
                                break 'idle;
                            }
                            visible = next.visible;
                            continue 'idle;
                        }
                        result = idle_adapter.has_running_containers() => result,
                    };
                    // Errors return to normal connection/backoff handling.
                    if !matches!(result, Ok(false)) { break; }
                    self.transition(
                        generation, DockerStatus::IdleSuspended,
                        Some("No running containers. Monitoring paused to save power.".into()),
                        "idle_suspended",
                    );
                }
            }
        }
        true
    }
}

impl DockerHandle {
    async fn event_since(&self, engine: &str) -> Option<String> {
        let live_since = self
            .inner
            .lock_ok()
            .events
            .iter()
            .rev()
            .find(|e| e.engine_id == engine)
            .map(|e| {
                format!(
                    "{}.{:09}",
                    e.time_ms / 1000,
                    e.time_ns.parse::<i64>().unwrap_or(0) % 1_000_000_000
                )
            });
        let recorder = Arc::clone(&self.recorder);
        let daemon = engine.to_owned();
        let durable = tokio::task::spawn_blocking(move || recorder.event_cursor(&daemon))
            .await
            .ok()
            .flatten();
        live_since.or_else(|| {
            durable
                .and_then(|s| s.parse::<i64>().ok())
                .map(|ns| format!("{}.{:09}", ns / 1_000_000_000, ns % 1_000_000_000))
        })
    }

    /// Compares `now` with the handle's last reading, which outlives the session, so
    /// a step between sessions is a step too.
    pub(super) fn check_clock(
        &self,
        now: crate::ClockReading,
        samples: &mut Samples,
        generation: u32,
    ) {
        let before = self.clock.lock_ok().replace(now);
        if before.is_some_and(|before| clock_stepped(&before, &now)) {
            samples.baseline.clear();
            let _gate = self.gate.lock_ok();
            if self.control.borrow().generation == generation {
                self.step_clock(now.wall_ms);
            }
        }
    }
    /// The recorder and the published records forget the same span, so the
    /// recorder sees no record it does not already hold, and the step opens one
    /// engine-wide `clock_step` at the new time. The published rows' observations
    /// carry the old clock's times: they go in the same update, so the step's own
    /// record never re-records them.
    pub(super) fn step_clock(&self, wall: i64) {
        self.recorder.clock_step(wall);
        self.update(|s| {
            step_coverage(&mut s.coverage, wall);
            for row in &mut s.containers {
                row.observed_ms = None;
                row.interval_ms = None;
            }
            s.interval_ms = 0;
        });
        self.gap_at("clock_step", wall);
    }
}

/// Whether the wall clock moved more than 2 s away from the time that passed, measured
/// on a clock that keeps counting while the Mac sleeps: a wake is not a step.
pub(super) fn clock_stepped(before: &crate::ClockReading, now: &crate::ClockReading) -> bool {
    now.wall_ms
        .saturating_sub(before.wall_ms)
        .saturating_sub(now.continuous_ms_since(before))
        .abs()
        > 2000
}

/// Whether a control change ends work started for `generation`: the channel closed,
/// the generation moved on, or the worker is shutting down.
fn superseded(
    changed: Result<(), watch::error::RecvError>,
    controls: &watch::Receiver<Control>,
    generation: u32,
) -> bool {
    let control = controls.borrow();
    changed.is_err() || control.generation != generation || control.shutdown
}

/// How a connected session ended.
#[derive(PartialEq)]
enum SessionEnd {
    /// The controls moved to a new generation or shut down.
    Changed,
    /// No container is running; the worker idles.
    Idle,
    /// The engine stopped answering.
    Disconnected,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_visibility_change_during_the_probe_still_publishes_and_backs_off() {
        let handle = DockerHandle::new(
            HostId(uuid::Uuid::new_v4()),
            DockerSettings {
                enabled: true,
                selected_engine: Some("/nonexistent/statglass-test.sock".into()),
                ..Default::default()
            },
            PathBuf::new(),
        );
        let mut controls = handle.control.subscribe();
        let control = controls.borrow_and_update().clone();
        // Pending before the probe starts, so the change is seen while it runs.
        handle.set_visible(true);
        let mut retry = FIRST_RETRY_SECONDS;
        handle
            .back_off_unavailable(&mut controls, &control, ("down".into(), None), &mut retry)
            .await;
        let snapshot = handle.snapshot();
        assert_eq!(snapshot.status, DockerStatus::Unavailable);
        assert!(snapshot.availability.is_some(), "reason published");
        assert_eq!(retry, 2, "backoff advanced");
    }

    #[tokio::test]
    async fn a_failed_unselected_attempt_classifies_from_the_engines_it_probed() {
        let handle = DockerHandle::new(
            HostId(uuid::Uuid::new_v4()),
            DockerSettings {
                enabled: true,
                ..Default::default()
            },
            PathBuf::new(),
        );
        let mut controls = handle.control.subscribe();
        let control = controls.borrow_and_update().clone();
        // Two engines answered and neither is preferred: this machine's own engines,
        // whatever they are, must not change the reason.
        let answering = |socket: &str| DockerEngine {
            id: socket.into(),
            socket: socket.into(),
            runtime: "Test".into(),
            context: None,
            daemon_id: None,
            reachable: true,
            preferred: false,
            error: None,
            api_version: None,
            capacity_bytes: None,
            capacity_observed_ms: None,
        };
        let probed = vec![answering("/a.sock"), answering("/b.sock")];
        assert_eq!(unselected_choice(&probed), None);
        let failure = ConnectFailure {
            error: DockerError::Unavailable,
            probed: Some(probed),
        };
        tokio::time::pause();
        let mut retry = FIRST_RETRY_SECONDS;
        handle
            .connect_failed(&mut controls, &control, failure, &mut retry)
            .await;
        let snapshot = handle.snapshot();
        assert_eq!(snapshot.status, DockerStatus::Unavailable);
        let reason = snapshot.availability.map(|a| a.reason);
        assert_eq!(reason, Some(DockerUnavailableReason::ChooseEngine));
    }
}
