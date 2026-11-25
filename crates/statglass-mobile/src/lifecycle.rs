//! The app's lifecycle as the sessions see it: backgrounding quiesces every source,
//! foregrounding resumes demanded sources, and path changes reach the sources.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use statglass_engine::Source;
use statglass_ipc::error::CommandError;
use statglass_ipc::mobile::{DataPolicy, DemandLevel};
use statglass_schema::HostId;
use statglass_schema::lock::LockExt;
use statglass_session::BoxFuture;
use statglass_session::network::{self, LocalNetwork};
use tokio::task::AbortHandle;
use tokio::time::Instant;

use crate::control::SessionControl;
use crate::ffi::NetworkPath;
use crate::policy::live_allowed;

/// The last path and data policy the app reported, and whether it is backgrounded.
pub(crate) struct Lifecycle {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    path: Option<NetworkPath>,
    data: DataPolicy,
    backgrounded: bool,
    demand: HashMap<HostId, DemandLevel>,
    sources: HashMap<HostId, Tracked>,
}

struct Tracked {
    entry: Weak<dyn DemandSource>,
    grace: Option<(Instant, AbortHandle)>,
}

pub(crate) trait DemandSource: Send + Sync {
    fn level(&self, level: Option<DemandLevel>);
    fn resume(&self);
    fn park(&self, close_streams: bool) -> BoxFuture<'static, ()>;
}

impl State {
    fn effective(&self, host: HostId) -> Option<DemandLevel> {
        if self.backgrounded {
            return None;
        }
        self.demand.get(&host).map(|level| {
            if *level == DemandLevel::Full && live_allowed(self.path, self.data) {
                DemandLevel::Full
            } else {
                DemandLevel::Compact
            }
        })
    }

    fn refresh_levels(&self) {
        for (&host, slot) in &self.sources {
            if let Some(entry) = slot.entry.upgrade() {
                entry.level(self.effective(host));
            }
        }
    }
}

impl Lifecycle {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::default(),
        }
    }

    /// Installs a runner already parked, so setting its first interest and allowing
    /// it to dial are serialized with foreground and background transitions.
    pub(crate) fn track(
        &self,
        host: HostId,
        entry: Arc<dyn DemandSource>,
        start: impl FnOnce() -> Result<(), CommandError>,
    ) -> Result<(), CommandError> {
        let mut state = self.state.lock_ok();
        start()?;
        if let Some(old) = state.sources.insert(
            host,
            Tracked {
                entry: Arc::downgrade(&entry),
                grace: None,
            },
        ) && let Some((_, grace)) = old.grace
        {
            grace.abort();
        }
        let level = state.effective(host);
        entry.level(level);
        if level.is_some() {
            entry.resume();
        }
        Ok(())
    }

    pub(crate) fn replace_demand(
        self: &Arc<Self>,
        next: HashMap<HostId, DemandLevel>,
        park_grace: Duration,
    ) {
        let mut state = self.state.lock_ok();
        let previous = std::mem::replace(&mut state.demand, next);
        state
            .sources
            .retain(|_, slot| slot.entry.strong_count() > 0);
        for (&host, &level) in &previous {
            if !state.demand.contains_key(&host) {
                self.release(&mut state, host, park_grace);
            } else if state.demand.get(&host) != Some(&level)
                && let Some(entry) = state
                    .sources
                    .get(&host)
                    .and_then(|slot| slot.entry.upgrade())
            {
                entry.level(state.effective(host));
            }
        }
        let added: Vec<_> = state
            .demand
            .keys()
            .filter(|host| !previous.contains_key(host))
            .copied()
            .collect();
        for host in added {
            let level = state.effective(host);
            if let Some(slot) = state.sources.get_mut(&host) {
                if let Some((_, timer)) = slot.grace.take() {
                    timer.abort();
                }
                if let Some(entry) = slot.entry.upgrade() {
                    entry.level(level);
                    if level.is_some() {
                        entry.resume();
                    }
                }
            }
        }
    }

    fn release(self: &Arc<Self>, state: &mut State, host: HostId, grace: Duration) {
        let Some(slot) = state.sources.get_mut(&host) else {
            return;
        };
        let Some(entry) = slot.entry.upgrade() else {
            return;
        };
        entry.level(None);
        if state.backgrounded {
            return;
        }
        let lifecycle = Arc::downgrade(self);
        let expires = Instant::now() + grace;
        let timer = tokio::spawn(async move {
            tokio::time::sleep_until(expires).await;
            let pending = lifecycle.upgrade().and_then(|lifecycle| {
                let mut state = lifecycle.state.lock_ok();
                if state.demand.contains_key(&host) {
                    return None;
                }
                let slot = state.sources.get_mut(&host)?;
                if slot.grace.as_ref()?.0 != expires {
                    return None;
                }
                slot.grace = None;
                Some(slot.entry.upgrade()?.park(true))
            });
            if let Some(parked) = pending {
                parked.await;
            }
        })
        .abort_handle();
        slot.grace = Some((expires, timer));
    }

    /// Quiesces every source and resolves once each has closed its session.
    pub(crate) fn quiesce(&self, sessions: &dyn SessionControl) -> BoxFuture<'static, ()> {
        // Registry installation takes the registry lock before the lifecycle lock.
        let sources = sessions.sources();
        let mut state = self.state.lock_ok();
        state.backgrounded = true;
        let mut pending: Vec<_> = sources.iter().map(|source| source.quiesce()).collect();
        let State {
            demand, sources, ..
        } = &mut *state;
        for (host, slot) in sources {
            if let Some((_, grace)) = slot.grace.take() {
                grace.abort();
            }
            if let Some(entry) = slot.entry.upgrade() {
                entry.level(None);
                pending.push(entry.park(!demand.contains_key(host)));
            }
        }
        Box::pin(async move {
            for parked in pending {
                parked.await;
            }
        })
    }

    /// Resumes demanded sources, the open host's first.
    pub(crate) fn resume(&self, sessions: &dyn SessionControl) {
        let sources = sessions.sources();
        let mut state = self.state.lock_ok();
        if !state.backgrounded {
            return;
        }
        state.backgrounded = false;
        let order: Vec<_> = sources.iter().map(|source| source.host().id).collect();
        let mut demand: Vec<_> = state.demand.keys().copied().collect();
        demand.sort_by_key(|host| {
            (
                state.demand.get(host) != Some(&DemandLevel::Full),
                order.iter().position(|id| id == host).unwrap_or(usize::MAX),
            )
        });
        for host in demand {
            if let Some(entry) = state
                .sources
                .get(&host)
                .and_then(|slot| slot.entry.upgrade())
            {
                entry.level(state.effective(host));
                entry.resume();
            }
        }
    }

    /// Records the path and tells the sources the network changed.
    pub(crate) fn path_changed(&self, sessions: &dyn SessionControl, path: NetworkPath) {
        self.path_changed_with_probe(sessions, path, network::probe);
    }

    fn path_changed_with_probe(
        &self,
        sessions: &dyn SessionControl,
        path: NetworkPath,
        probe: impl FnOnce() -> LocalNetwork,
    ) {
        let network = LocalNetwork {
            online: path.satisfied,
            ..probe()
        };
        let mut state = self.state.lock_ok();
        state.path = Some(path);
        state.refresh_levels();
        drop(state);
        sessions.network_changed(network);
    }

    /// Records the data policy.
    pub(crate) fn set_data_policy(&self, data: DataPolicy) {
        let mut state = self.state.lock_ok();
        state.data = data;
        state.refresh_levels();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use statglass_engine::{Source, SourceHandle, SourceSink};
    use statglass_proto::{Hello, Message};
    use statglass_schema::{HostId, HostInfo, HostRecord, OsKind, lock::LockExt};
    use statglass_session::network::LocalNetwork;
    use statglass_session::{
        Close, DialFailure, DialedStream, Dialer, Endpoint, RemoteError, RemoteSource, Route,
        SourceOptions, Target, codec,
    };
    use tokio::io::{DuplexStream, duplex};
    use tokio::sync::mpsc;
    use tokio::time::timeout;

    use super::*;

    const WAIT: Duration = Duration::from_secs(1);
    const TEN_MINUTES: Duration = Duration::from_secs(600);

    #[derive(Default)]
    struct TestSessions {
        sources: Vec<Arc<RemoteSource>>,
        networks: Mutex<Vec<LocalNetwork>>,
    }

    impl SessionControl for TestSessions {
        fn sources(&self) -> Vec<Arc<RemoteSource>> {
            self.sources.clone()
        }

        fn network_changed(&self, network: LocalNetwork) {
            self.networks.lock_ok().push(network);
            for source in &self.sources {
                source.network_changed_with(network);
            }
        }
    }

    impl TestSessions {
        fn start_source(&mut self, id: u8, host: &str, dialer: Arc<dyn Dialer>) -> SourceHandle {
            let source = RemoteSource::with_options(
                HostRecord {
                    id: HostId(format!("00000000-0000-0000-0000-{id:012}").parse().unwrap()),
                    display_name: host.into(),
                    is_local: false,
                    info: HostInfo {
                        os: OsKind::MacOs,
                        os_version: "15".into(),
                        model: None,
                        chip: None,
                        chip_known: false,
                        cpu_topology: vec![],
                        mem_total_bytes: 1,
                        boot_time_ms: 0,
                        gpu_dvfs_mhz: vec![],
                        kernel: None,
                        boot_mounts: vec![],
                    },
                },
                HostId(Default::default()),
                dialer,
                Endpoint {
                    targets: vec![Target {
                        host: host.into(),
                        route: Route::Lan,
                    }],
                    port: None,
                    user: None,
                    host_keys: vec![],
                    command: Default::default(),
                },
                Arc::new(|_| {}),
                None,
                SourceOptions {
                    runtime: Some(tokio::runtime::Handle::current()),
                    probe: Some(Arc::new(|| LocalNetwork {
                        online: true,
                        lan_up: true,
                        tailscale_up: false,
                    })),
                },
            );
            let handle = source
                .clone()
                .start(SourceSink {
                    live: Default::default(),
                    store: None,
                })
                .unwrap();
            self.sources.push(source);
            handle
        }
    }

    struct Attempt {
        host: String,
        peer: Option<DuplexStream>,
    }

    struct TestDialer {
        connects: bool,
        attempts: mpsc::UnboundedSender<Attempt>,
    }

    struct InMemoryClose;

    impl Close for InMemoryClose {
        fn close(self: Box<Self>) -> BoxFuture<'static, ()> {
            Box::pin(async {})
        }
    }

    impl Dialer for TestDialer {
        fn dial<'a>(
            &'a self,
            _: &'a Endpoint,
            target: &'a Target,
        ) -> BoxFuture<'a, statglass_session::Result<DialedStream>> {
            Box::pin(async move {
                let (stream, peer) = if self.connects {
                    let (stream, peer) = duplex(4096);
                    let (reader, writer) = tokio::io::split(stream);
                    (
                        Ok(DialedStream {
                            reader: Box::pin(reader),
                            writer: Box::pin(writer),
                            stderr: Default::default(),
                            close: Box::new(InMemoryClose),
                        }),
                        Some(peer),
                    )
                } else {
                    (Err(RemoteError::Transport("test dial failed".into())), None)
                };
                self.attempts
                    .send(Attempt {
                        host: target.host.clone(),
                        peer,
                    })
                    .unwrap();
                stream
            })
        }

        fn classify(&self, failure: &DialFailure<'_>) -> RemoteError {
            RemoteError::Transport(failure.outcome.sentence().into())
        }
    }

    async fn next_attempt(attempts: &mut mpsc::UnboundedReceiver<Attempt>) -> Attempt {
        timeout(WAIT, attempts.recv()).await.unwrap().unwrap()
    }

    #[tokio::test(start_paused = true)]
    async fn backgrounding_parks_every_source_even_if_called_again_after_adding_one() {
        let lifecycle = Lifecycle::new();
        let mut sessions = TestSessions::default();
        let (sent, mut attempts) = mpsc::unbounded_channel();
        let dialer = Arc::new(TestDialer {
            connects: false,
            attempts: sent,
        });
        let _open = sessions.start_source(1, "open", dialer.clone());
        assert_eq!(next_attempt(&mut attempts).await.host, "open");

        timeout(WAIT, lifecycle.quiesce(&sessions)).await.unwrap();
        assert!(timeout(TEN_MINUTES, attempts.recv()).await.is_err());

        let _late = sessions.start_source(2, "late", dialer);
        assert_eq!(next_attempt(&mut attempts).await.host, "late");
        let quiesced = lifecycle.quiesce(&sessions);
        assert!(timeout(TEN_MINUTES, attempts.recv()).await.is_err());
        timeout(WAIT, quiesced).await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn resume_without_backgrounding_keeps_the_existing_session() {
        let lifecycle = Lifecycle::new();
        let mut sessions = TestSessions::default();
        let (sent, mut attempts) = mpsc::unbounded_channel();
        let handle = sessions.start_source(
            1,
            "open",
            Arc::new(TestDialer {
                connects: true,
                attempts: sent,
            }),
        );
        let mut peer = next_attempt(&mut attempts).await.peer.unwrap();
        let hello = Hello {
            proto_version: statglass_proto::PROTO_VERSION,
            min_compatible: statglass_proto::MIN_COMPATIBLE,
            app_version: "test".into(),
            host: sessions.sources[0].host().identity(),
            db_instance_uuid: Default::default(),
            capabilities: Default::default(),
            features: statglass_proto::local_features(),
        };
        codec::write(&mut peer, &Message::Hello(Box::new(hello)))
            .await
            .unwrap();
        assert!(matches!(read(&mut peer).await, Message::HelloAck(_)));
        assert!(matches!(read(&mut peer).await, Message::Interest(_)));
        assert!(matches!(read(&mut peer).await, Message::Ping { .. }));

        lifecycle.resume(&sessions);
        handle.control().set_detail_interest(true);
        assert!(matches!(read(&mut peer).await, Message::Interest(interest) if interest.detail));
        assert!(matches!(
            attempts.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
    }

    async fn read(peer: &mut DuplexStream) -> Message {
        timeout(WAIT, codec::read(peer)).await.unwrap().unwrap()
    }

    #[test]
    fn quiesce_without_sources_is_immediately_ready() {
        let mut quiesced = Lifecycle::new().quiesce(&TestSessions::default());
        let mut context = std::task::Context::from_waker(std::task::Waker::noop());
        assert!(quiesced.as_mut().poll(&mut context).is_ready());
    }

    #[test]
    fn every_path_notification_uses_satisfied_as_the_online_signal() {
        let lifecycle = Lifecycle::new();
        let sessions = TestSessions::default();
        for satisfied in [true, false, false, true] {
            lifecycle.path_changed(
                &sessions,
                NetworkPath {
                    satisfied,
                    expensive: false,
                    constrained: false,
                },
            );
        }
        let online: Vec<_> = sessions
            .networks
            .lock_ok()
            .iter()
            .map(|net| net.online)
            .collect();
        assert_eq!(online, [true, false, false, true]);
    }

    #[test]
    fn probing_the_network_leaves_the_lifecycle_available() {
        let lifecycle = Lifecycle::new();
        let sessions = TestSessions::default();
        let path = NetworkPath {
            satisfied: true,
            expensive: false,
            constrained: false,
        };

        lifecycle.path_changed_with_probe(&sessions, path, || {
            // Check before calling resume so a lock regression fails instead of hanging.
            assert!(lifecycle.state.try_lock().is_ok());
            lifecycle.resume(&sessions);
            LocalNetwork {
                online: false,
                lan_up: true,
                tailscale_up: false,
            }
        });

        assert_eq!(
            *sessions.networks.lock_ok(),
            [LocalNetwork {
                online: true,
                lan_up: true,
                tailscale_up: false,
            }]
        );
    }
}
