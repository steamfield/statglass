use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex};

use statglass_engine::{LiveHub, Source, SourceHandle, SourceSink, wall_ms};
use statglass_ipc::error::CommandError;
use statglass_ipc::mobile::{MobileEvent, MobileHost, MobileRemoteHost};
use statglass_ipc::status::{RemoteConnection, connection_status};
use statglass_ipc::vitals::{HostVitals, VitalsRateLimit, host_vitals};
use statglass_schema::lock::LockExt;
use statglass_schema::{HostId, HostRecord};
use statglass_session::{
    ConnectionFailureKind, ConnectionStatus, Dialer, RemoteSource, SourceOptions,
};
use tokio::runtime::Handle;
use tokio::task::JoinHandle;

use crate::ffi::{CoreEvents, NativeSigner, NativeSignerError};

use super::{endpoint, internal, invalid};

pub(super) struct HostEntry {
    pub(super) config: MobileHost,
    pub(super) source: Arc<RemoteSource>,
    pub(super) hub: LiveHub,
    pub(super) handle: Mutex<Option<SourceHandle>>,
    status: Mutex<Status>,
    vitals_warnings: VitalsRateLimit,
}

pub(super) enum OpenError {
    Command(CommandError),
    /// The key is missing or locked. The diagnostic goes to the status line only; the
    /// command error stays the diagnostic-free `phone_key_unavailable`.
    KeyUnavailable(String),
    /// The native signer failed unexpectedly.
    SignerInternal(CommandError),
    Panicked(CommandError),
}

static PHONE_KEY_UNAVAILABLE: CommandError = CommandError::PhoneKeyUnavailable;

impl From<CommandError> for OpenError {
    fn from(error: CommandError) -> Self {
        Self::Command(error)
    }
}

impl OpenError {
    pub(super) fn command(&self) -> &CommandError {
        match self {
            Self::KeyUnavailable(_) => &PHONE_KEY_UNAVAILABLE,
            Self::Command(error) | Self::SignerInternal(error) | Self::Panicked(error) => error,
        }
    }

    /// The connection status line, which keeps the native diagnostic.
    fn message(&self) -> String {
        match self {
            Self::KeyUnavailable(diagnostic) => diagnostic.clone(),
            _ => self.command().to_string(),
        }
    }

    fn failure_kind(&self) -> Option<ConnectionFailureKind> {
        match self {
            Self::Command(_) => None,
            Self::KeyUnavailable(_) => Some(ConnectionFailureKind::PhoneKeyUnavailable),
            Self::SignerInternal(_) | Self::Panicked(_) => Some(ConnectionFailureKind::Internal),
        }
    }
}

#[derive(Default)]
struct Status {
    connection: ConnectionStatus,
    notice: Option<StatusNotice>,
    published: Option<StatusNotice>,
    active: bool,
    dirty: bool,
    checking: bool,
    previous_timeline: Option<u32>,
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
        signer: Option<&dyn NativeSigner>,
    ) -> Result<Arc<Self>, OpenError> {
        let record = endpoint::record(&config);
        let endpoint = endpoint::endpoint(&config);
        endpoint
            .validate()
            .map_err(|error| invalid(error.to_string()))?;
        if let Some(signer) = signer {
            if endpoint.host_keys.is_empty() {
                return Err(invalid("a paired SSH host key is required").into());
            }
            check_phone_key(signer)?;
        }
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
                record, phone, dialer, endpoint, on_status, None, options,
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
        {
            let mut status = self.status.lock_ok();
            status.active = true;
            status.connection.retrying = true;
        }
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
        self.vitals_for(&self.status.lock_ok())
    }

    fn vitals_for(&self, status: &Status) -> HostVitals {
        let latest = self.hub.latest_frame();
        let current = latest.as_ref().filter(|frame| {
            status.connection.connected && Some(frame.timeline) != status.previous_timeline
        });
        let Some(frame) = current else {
            return HostVitals {
                as_of_ms: latest.map(|frame| frame.ts_ms),
                ..Default::default()
            };
        };
        let mut vitals = host_vitals(
            Some(frame),
            self.config.id,
            &self.source.host().info,
            &self.vitals_warnings,
        );
        vitals.as_of_ms = Some(self.source.clock().now_ms().unwrap_or_else(|| {
            // A frame gives us host time before the first heartbeat estimates the offset.
            let now = wall_ms();
            let elapsed = now.saturating_sub(status.connection.last_seen_ms.unwrap_or(now));
            frame.ts_ms.saturating_add(elapsed.max(0))
        }));
        vitals
    }

    pub(super) fn remote_host(&self) -> MobileRemoteHost {
        let status = self.status.lock_ok();
        remote_host(
            &self.config,
            self.source.host(),
            &status.connection,
            self.vitals_for(&status),
        )
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
        if !connection.connected {
            // The live hub keeps its latest frame across reconnects.
            status.previous_timeline = self.hub.latest_frame().map(|frame| frame.timeline);
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

fn check_phone_key(signer: &dyn NativeSigner) -> Result<(), OpenError> {
    let key = catch_unwind(AssertUnwindSafe(|| signer.public_key()))
        .map_err(|payload| {
            OpenError::Panicked(crate::envelope::panicked(
                payload.as_ref(),
                "reading phone key",
            ))
        })?
        .map_err(|error| {
            let diagnostic = format!("reading the phone's SSH public key: {error}");
            match error {
                NativeSignerError::Unavailable { .. } => OpenError::KeyUnavailable(diagnostic),
                NativeSignerError::Unexpected { .. } => {
                    OpenError::SignerInternal(internal(diagnostic))
                }
            }
        })?;
    match key.as_slice() {
        [] => Err(OpenError::KeyUnavailable(
            "the phone's SSH public key is unavailable".into(),
        )),
        [4, coordinates @ ..] if coordinates.len() == 64 => Ok(()),
        _ => Err(internal("the phone's SSH public key is not an uncompressed P-256 point").into()),
    }
}

pub(super) fn unopened_host(host: &MobileHost, error: Option<&OpenError>) -> MobileRemoteHost {
    let status = ConnectionStatus {
        retrying: error.is_none(),
        error: error.map(OpenError::message),
        failure_kind: error.and_then(OpenError::failure_kind),
        ..Default::default()
    };
    let mut row = remote_host(host, endpoint::record(host), &status, HostVitals::default());
    row.open_error = error.map(|error| error.command().clone());
    row
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
        demand: None,
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
