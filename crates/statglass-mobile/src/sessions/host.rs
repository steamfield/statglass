use std::sync::{Arc, Mutex};

use statglass_engine::{LiveHub, Source, SourceHandle, SourceSink};
use statglass_ipc::error::CommandError;
use statglass_ipc::mobile::{MobileEvent, MobileHost, MobileRemoteHost};
use statglass_ipc::status::{RemoteConnection, connection_status};
use statglass_ipc::vitals::{HostVitals, VitalsRateLimit, host_vitals};
use statglass_schema::lock::LockExt;
use statglass_schema::{HostId, HostRecord};
use statglass_session::{ConnectionStatus, Dialer, RemoteSource, SourceOptions};
use tokio::runtime::Handle;
use tokio::task::JoinHandle;

use crate::ffi::CoreEvents;

use super::{endpoint, internal};

pub(super) struct HostEntry {
    pub(super) config: MobileHost,
    pub(super) source: Arc<RemoteSource>,
    pub(super) hub: LiveHub,
    pub(super) handle: Mutex<Option<SourceHandle>>,
    status: Mutex<Status>,
    vitals_warnings: VitalsRateLimit,
}

#[derive(Default)]
struct Status {
    connection: ConnectionStatus,
    notice: Option<StatusNotice>,
    published: Option<StatusNotice>,
    active: bool,
    dirty: bool,
    checking: bool,
}

#[derive(Clone, PartialEq)]
struct StatusNotice {
    connection: RemoteConnection,
    next_attempt_ms: Option<i64>,
    attempt: u32,
    dialing: bool,
    waiting_for_network: bool,
    agent_version: Option<String>,
    identity_changed: Option<HostId>,
}

impl From<&ConnectionStatus> for StatusNotice {
    fn from(status: &ConnectionStatus) -> Self {
        Self {
            connection: connection_status(status),
            next_attempt_ms: status.next_attempt_ms,
            attempt: status.attempt,
            dialing: status.dialing,
            waiting_for_network: status.waiting_for_network,
            agent_version: status.remote_version.clone(),
            identity_changed: status.identity_changed,
        }
    }
}

impl HostEntry {
    pub(super) fn open(
        config: MobileHost,
        phone: statglass_schema::HostId,
        dialer: Arc<dyn Dialer>,
        events: Arc<dyn CoreEvents>,
        options: SourceOptions,
    ) -> Result<Arc<Self>, CommandError> {
        let record = endpoint::record(&config);
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
                None,
                options,
            );
            Self {
                config,
                source,
                hub: LiveHub::new(Default::default()),
                handle: Mutex::default(),
                status: Mutex::default(),
                vitals_warnings: VitalsRateLimit::default(),
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

    pub(super) fn vitals(&self) -> HostVitals {
        host_vitals(
            self.hub.latest_frame().as_deref(),
            self.config.id,
            &self.source.host().info,
            &self.vitals_warnings,
        )
    }

    pub(super) fn remote_host(&self) -> MobileRemoteHost {
        let status = self.status.lock_ok().connection.clone();
        remote_host(&self.config, self.source.host(), &status, self.vitals())
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
        let notice = StatusNotice::from(&connection);
        status.connection = connection;
        if status.notice.as_ref() == Some(&notice) {
            return None;
        }
        // Frames update observations for ListRemoteHosts. Notify on status transitions.
        status.notice = Some(notice);
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
            let next = {
                let mut status = self.status.lock_ok();
                if !status.active || !status.dirty {
                    status.checking = false;
                    return;
                }
                status.dirty = false;
                status.notice.clone()
            };
            let mut status = self.status.lock_ok();
            if !status.active || status.dirty || status.published == next {
                continue;
            }
            status.published = next;
            drop(status);
            super::registry::emit(events, MobileEvent::RemoteHostsChanged);
        }
    }
}

pub(super) fn unopened_host(host: &MobileHost, error: Option<&CommandError>) -> MobileRemoteHost {
    let status = ConnectionStatus {
        retrying: error.is_none(),
        error: error.map(ToString::to_string),
        ..Default::default()
    };
    remote_host(host, endpoint::record(host), &status, HostVitals::default())
}

fn remote_host(
    host: &MobileHost,
    record: HostRecord,
    status: &ConnectionStatus,
    vitals: HostVitals,
) -> MobileRemoteHost {
    MobileRemoteHost {
        id: record.id,
        name: record.display_name,
        os: record.info.os,
        targets: host.targets.clone(),
        open_error: None,
        connection: connection_status(status),
        last_seen_ms: status
            .last_seen_ms
            .map(|seen| seen.saturating_add(status.clock_offset_ms)),
        synced_through_ms: None,
        next_attempt_ms: status.next_attempt_ms,
        attempt: status.attempt,
        dialing: status.dialing,
        waiting_for_network: status.waiting_for_network,
        clock_offset_ms: (status.connected || status.last_seen_ms.is_some())
            .then_some(status.clock_offset_ms),
        vitals,
        agent_version: status.remote_version.clone(),
        identity_changed: status.identity_changed,
    }
}
