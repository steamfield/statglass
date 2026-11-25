use std::path::Path;
use std::sync::{Arc, Mutex, RwLock};

use statglass_engine::{HistoryStore, LiveHub, Source, SourceHandle, SourceSink};
use statglass_ipc::error::CommandError;
use statglass_ipc::mobile::{MobileEvent, MobileHost, MobileRemoteHost};
use statglass_ipc::status::connection_status;
use statglass_ipc::vitals::{HostVitals, host_vitals};
use statglass_schema::lock::{LockExt, RwLockExt};
use statglass_session::{
    ConnectionStatus, Dialer, Mirror, MirrorPolicy, RemoteSource, SourceOptions,
};
use statglass_store::create_private_dir;
use tokio::runtime::Handle;
use tokio::task::JoinHandle;

use crate::ffi::CoreEvents;

use super::{endpoint, internal};

pub(super) struct HostEntry {
    pub(super) config: MobileHost,
    pub(super) policy: MirrorPolicy,
    pub(super) source: Arc<RemoteSource>,
    pub(super) mirror: Arc<Mirror>,
    pub(super) hub: LiveHub,
    pub(super) handle: Mutex<Option<SourceHandle>>,
    history_open: RwLock<bool>,
    status: Mutex<Status>,
}

#[derive(Default)]
struct Status {
    connection: ConnectionStatus,
    published: Option<MobileRemoteHost>,
    active: bool,
    dirty: bool,
    checking: bool,
}

impl HostEntry {
    pub(super) fn open(
        config: MobileHost,
        budget_mb: u32,
        data_dir: &Path,
        phone: statglass_schema::HostId,
        dialer: Arc<dyn Dialer>,
        events: Arc<dyn CoreEvents>,
        options: SourceOptions,
    ) -> Result<Arc<Self>, CommandError> {
        let dir = data_dir.join("mirrors").join(config.id.to_string());
        create_private_dir(&dir).map_err(|error| {
            internal(format!(
                "creating mirror directory {}: {error}",
                dir.display()
            ))
        })?;
        let record = endpoint::record(&config);
        let history = Arc::new(HistoryStore::open(&dir));
        history.register_host(&record);
        let policy = MirrorPolicy::phone(budget_mb);
        let mirror = Arc::new(Mirror::with_policy(history, config.id, policy.clone()));
        let runtime = options
            .runtime
            .clone()
            .ok_or_else(|| internal("mobile session needs a runtime"))?;
        Ok(Arc::new_cyclic(|entry: &std::sync::Weak<Self>| {
            let entry = entry.clone();
            let on_status = Arc::new(move |status| {
                if let Some(entry) = entry.upgrade() {
                    drop(entry.observe_status(status, &runtime, events.clone()));
                }
            });
            let source = RemoteSource::with_options(
                record,
                phone,
                dialer,
                endpoint::endpoint(&config),
                on_status,
                Some(mirror.clone()),
                options,
            );
            Self {
                config,
                policy,
                source,
                mirror,
                hub: LiveHub::new(Default::default()),
                handle: Mutex::default(),
                history_open: RwLock::new(true),
                status: Mutex::default(),
            }
        }))
    }

    pub(super) fn start(&self) -> Result<(), CommandError> {
        self.status.lock_ok().active = true;
        let handle = self.source.clone().start(SourceSink {
            live: self.hub.clone(),
            store: None,
        });
        match handle {
            Ok(handle) => {
                *self.handle.lock_ok() = Some(handle);
                Ok(())
            }
            Err(error) => {
                self.deactivate();
                Err(internal(format!(
                    "starting session for {}: {error}",
                    self.config.id
                )))
            }
        }
    }

    pub(super) fn deactivate(&self) {
        self.status.lock_ok().active = false;
    }

    pub(super) fn is_active(&self) -> bool {
        self.status.lock_ok().active
    }

    pub(super) fn with_history<T>(
        &self,
        f: impl FnOnce(&HistoryStore) -> Result<T, CommandError>,
    ) -> Result<T, CommandError> {
        let open = self.history_open.read_ok();
        if !*open {
            return Err(CommandError::UnknownHost {
                host: self.config.id,
            });
        }
        f(&self.mirror.store())
    }

    pub(super) fn close_history(&self) {
        let mut open = self.history_open.write_ok();
        *open = false;
        self.mirror.store().close();
    }

    pub(super) fn vitals(&self) -> HostVitals {
        host_vitals(
            self.hub.latest_frame().as_deref(),
            self.config.id,
            &self.source.host().info,
        )
    }

    pub(super) fn remote_host(&self) -> MobileRemoteHost {
        let status = self.status.lock_ok().connection.clone();
        self.project(&status)
    }

    pub(super) fn observe_status(
        self: &Arc<Self>,
        connection: ConnectionStatus,
        runtime: &Handle,
        events: Arc<dyn CoreEvents>,
    ) -> Option<JoinHandle<()>> {
        let mut status = self.status.lock_ok();
        if !status.active {
            return None;
        }
        status.connection = connection;
        status.dirty = true;
        if status.checking {
            return None;
        }
        status.checking = true;
        let entry = self.clone();
        Some(runtime.spawn_blocking(move || entry.publish_pending_status(&*events)))
    }

    fn publish_pending_status(&self, events: &dyn CoreEvents) {
        loop {
            let connection = {
                let mut status = self.status.lock_ok();
                if !status.active || !status.dirty {
                    status.checking = false;
                    return;
                }
                status.dirty = false;
                status.connection.clone()
            };
            let next = self.project(&connection);
            let mut status = self.status.lock_ok();
            if !status.active || status.dirty || status.published.as_ref() == Some(&next) {
                continue;
            }
            status.published = Some(next);
            drop(status);
            super::registry::emit(events, MobileEvent::RemoteHostsChanged);
        }
    }

    fn project(&self, status: &ConnectionStatus) -> MobileRemoteHost {
        let record = self.source.host();
        MobileRemoteHost {
            id: record.id,
            name: record.display_name,
            os: record.info.os,
            targets: self.config.targets.clone(),
            mirror_budget_mb: self.policy.budget_mb(),
            connection: connection_status(status),
            last_seen_ms: status
                .last_seen_ms
                .map(|seen| seen.saturating_add(status.clock_offset_ms)),
            synced_through_ms: self
                .mirror
                .sync_watermark()
                .ok()
                .and_then(|w| w.synced_through()),
            next_attempt_ms: status.next_attempt_ms,
            attempt: status.attempt,
            dialing: status.dialing,
            waiting_for_network: status.waiting_for_network,
            clock_offset_ms: (status.connected || status.last_seen_ms.is_some())
                .then_some(status.clock_offset_ms),
            vitals: host_vitals(self.hub.latest_frame().as_deref(), record.id, &record.info),
            agent_version: status.remote_version.clone(),
            identity_changed: status.identity_changed,
        }
    }
}
