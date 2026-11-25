use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};

use statglass_engine::Source;
use statglass_ipc::error::CommandError;
use statglass_ipc::mobile::{MobileEvent, MobileHost};
use statglass_schema::{HostId, HostRecord, lock::LockExt};
use statglass_session::network::LocalNetwork;
use statglass_session::{Dialer, RemoteSource, SourceOptions};
use tokio::runtime::Handle;

use crate::ffi::{CoreEvents, NativeSigner};
use crate::lifecycle::Lifecycle;

use super::{
    callback, endpoint,
    host::{HostEntry, OpenError},
    internal, invalid,
    live::Live,
    phone_id,
};

mod roster;
#[cfg(test)]
mod tests;

pub(super) struct Registry {
    pub(super) events: Arc<dyn CoreEvents>,
    pub(super) live: Arc<Live>,
    pub(super) lifecycle: Arc<Lifecycle>,
    signer: Option<Arc<dyn NativeSigner>>,
    // Serializes roster edits while new sources open outside the state lock.
    updates: Mutex<()>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    run: Option<Run>,
    network: Option<LocalNetwork>,
    roster_events: VecDeque<Vec<HostRecord>>,
    sending_roster: bool,
}

struct Run {
    context: Context,
    desired: Vec<MobileHost>,
    entries: HashMap<HostId, Arc<HostEntry>>,
    open_errors: HashMap<HostId, OpenError>,
    // A removal or replacement owns the slot until its session closes.
    retiring: HashMap<HostId, Option<Arc<RemoteSource>>>,
}

type OpenedHost = (HostId, Result<Arc<HostEntry>, OpenError>);

pub(super) enum Entry {
    Running(Arc<HostEntry>),
    Unopened {
        record: Box<HostRecord>,
        error: Option<CommandError>,
    },
}

impl Entry {
    pub(super) fn record(self) -> HostRecord {
        match self {
            Self::Running(entry) => entry.source.host(),
            Self::Unopened { record, .. } => *record,
        }
    }

    pub(super) fn ready(self) -> Result<Option<Arc<HostEntry>>, CommandError> {
        match self {
            Self::Running(entry) => Ok(Some(entry)),
            Self::Unopened {
                error: Some(error), ..
            } => Err(error),
            Self::Unopened { error: None, .. } => Ok(None),
        }
    }

    pub(super) fn running(self) -> Result<Arc<HostEntry>, CommandError> {
        self.ready()?.ok_or_else(connecting)
    }
}

#[derive(Clone)]
struct Context {
    runtime: Handle,
    phone: HostId,
    dialer: Arc<dyn Dialer>,
}

impl Registry {
    fn open(&self, context: &Context, host: MobileHost) -> Result<Arc<HostEntry>, OpenError> {
        let entry = HostEntry::open(
            host,
            context.phone,
            context.dialer.clone(),
            self.events.clone(),
            SourceOptions {
                runtime: Some(context.runtime.clone()),
                ..Default::default()
            },
            self.signer.as_deref(),
        )?;
        Ok(entry)
    }

    pub(super) fn new(events: Arc<dyn CoreEvents>, signer: Option<Arc<dyn NativeSigner>>) -> Self {
        Self {
            events,
            live: Arc::default(),
            lifecycle: Arc::new(Lifecycle::new()),
            signer,
            updates: Mutex::default(),
            state: Mutex::default(),
        }
    }

    pub(super) fn is_started(&self) -> bool {
        self.state.lock_ok().run.is_some()
    }

    pub(super) fn start(
        self: &Arc<Self>,
        runtime: Handle,
        data_dir: PathBuf,
        hosts: Vec<MobileHost>,
        dialer: Arc<dyn Dialer>,
    ) -> Result<(), CommandError> {
        {
            let _update = self.updates.lock_ok();
            if self.is_started() {
                return Err(internal("the mobile core has already started"));
            }
            validate(&hosts)?;
            let mut run = Run {
                context: Context {
                    phone: phone_id::load(&data_dir)?,
                    runtime,
                    dialer,
                },
                desired: Vec::new(),
                entries: HashMap::new(),
                open_errors: HashMap::new(),
                retiring: HashMap::new(),
            };
            let new = self.open_hosts(&run.context, &hosts);
            let mut state = self.state.lock_ok();
            self.apply_hosts(&mut run, hosts, new, state.network);
            state.run = Some(run);
            state.queue_roster();
        }
        self.emit_rosters();
        Ok(())
    }

    pub(super) fn set_hosts(self: &Arc<Self>, hosts: Vec<MobileHost>) -> Result<(), CommandError> {
        validate(&hosts)?;
        {
            let _update = self.updates.lock_ok();
            let (context, missing) = {
                let state = self.state.lock_ok();
                let run = state.run.as_ref().ok_or_else(not_started)?;
                let missing: Vec<_> = hosts
                    .iter()
                    .filter(|host| {
                        !run.entries.contains_key(&host.id) && !run.retiring.contains_key(&host.id)
                    })
                    .cloned()
                    .collect();
                (run.context.clone(), missing)
            };
            let new = self.open_hosts(&context, &missing);
            let mut state = self.state.lock_ok();
            let network = state.network;
            let run = state.run.as_mut().ok_or_else(not_started)?;
            self.apply_hosts(run, hosts, new, network);
            state.queue_roster();
        }
        self.emit_rosters();
        Ok(())
    }

    fn open_hosts(&self, context: &Context, hosts: &[MobileHost]) -> Vec<OpenedHost> {
        hosts
            .iter()
            .map(|host| (host.id, self.open(context, host.clone())))
            .collect()
    }

    fn apply_hosts(
        self: &Arc<Self>,
        run: &mut Run,
        hosts: Vec<MobileHost>,
        new: Vec<OpenedHost>,
        network: Option<LocalNetwork>,
    ) {
        let desired: HashSet<_> = hosts.iter().map(|host| host.id).collect();
        for host in &run.desired {
            if !desired.contains(&host.id) {
                self.live.remove_host(host.id);
            }
        }

        run.open_errors.retain(|id, _| desired.contains(id));
        run.desired = hosts;
        for opened in new {
            let _ = self.install(run, opened, network);
        }

        let retiring: Vec<_> = run
            .entries
            .values()
            .filter(|entry| {
                run.host(entry.config.id)
                    .is_none_or(|host| host != &entry.config)
            })
            .cloned()
            .collect();
        for entry in retiring {
            let id = entry.config.id;
            if run.host(id).is_none() {
                run.detach(id);
            }
            if let std::collections::hash_map::Entry::Vacant(slot) = run.retiring.entry(id) {
                slot.insert(Some(entry.source.clone()));
                self.retire(&run.context.runtime, entry);
            }
        }
    }

    fn install(
        &self,
        run: &mut Run,
        (id, opened): OpenedHost,
        network: Option<LocalNetwork>,
    ) -> Result<(), CommandError> {
        let result = opened.and_then(|entry| {
            if let Some(network) = network {
                entry.source.network_changed_with(network);
            }
            self.lifecycle.install(&entry)?;
            self.live.register(entry.clone(), &run.context.runtime);
            run.entries.insert(id, entry);
            Ok(())
        });
        match result {
            Ok(()) => {
                run.open_errors.remove(&id);
                Ok(())
            }
            Err(error) => {
                let command = error.command().clone();
                if !matches!(error, OpenError::Panicked(_)) {
                    tracing::error!(%id, error = &command as &dyn std::error::Error, "opening mobile session");
                }
                run.open_errors.insert(id, error);
                Err(command)
            }
        }
    }

    fn retire(self: &Arc<Self>, runtime: &Handle, entry: Arc<HostEntry>) {
        let id = entry.config.id;
        let registry = Arc::downgrade(self);
        let quiesced = entry.source.quiesce();
        runtime.spawn(async move {
            quiesced.await;
            if let Some(registry) = registry.upgrade()
                && let Some(run) = registry.state.lock_ok().run.as_mut()
            {
                run.detach(id);
            }
            // A concurrent resume may have started another dial. Stop the runner
            // and wait for it to park before opening its replacement.
            drop(entry.handle.lock_ok().take());
            entry.source.quiesce().await;
            if let Some(registry) = registry.upgrade()
                && let Some(run) = registry.state.lock_ok().run.as_mut()
            {
                run.retiring.insert(id, None);
            }
            let finished = tokio::task::spawn_blocking(move || {
                Self::replace_retired(registry, id);
            })
            .await;
            if let Err(error) = finished {
                tracing::error!(%id, %error, "replacing a mobile session");
            }
        });
    }

    fn replace_retired(registry: Weak<Self>, id: HostId) {
        let Some(registry) = registry.upgrade() else {
            return;
        };
        loop {
            let (context, host) = {
                let _update = registry.updates.lock_ok();
                let mut state = registry.state.lock_ok();
                let Some(run) = state.run.as_mut() else {
                    return;
                };
                let Some(host) = run.host(id).cloned() else {
                    run.retiring.remove(&id);
                    return;
                };
                (run.context.clone(), host)
            };
            let opened = registry.open(&context, host.clone());
            let update = registry.updates.lock_ok();
            let mut state = registry.state.lock_ok();
            let network = state.network;
            let Some(run) = state.run.as_mut() else {
                return;
            };
            if run.host(id) != Some(&host) {
                continue;
            }
            run.retiring.remove(&id);
            let _ = registry.install(run, (id, opened), network);
            state.queue_roster();
            drop(state);
            drop(update);
            registry.emit_rosters();
            return;
        }
    }

    pub(super) fn entry(&self, host: HostId) -> Result<Entry, CommandError> {
        let state = self.state.lock_ok();
        let run = state.run.as_ref().ok_or_else(not_started)?;
        let config = run.host(host).ok_or(CommandError::UnknownHost { host })?;
        Ok(match run.entries.get(&host) {
            Some(entry) => Entry::Running(entry.clone()),
            None => Entry::Unopened {
                record: Box::new(endpoint::record(config)),
                error: run
                    .open_errors
                    .get(&host)
                    .map(|error| error.command().clone()),
            },
        })
    }

    pub(super) fn sources(&self) -> Vec<Arc<RemoteSource>> {
        let open = self.live.open_host();
        let state = self.state.lock_ok();
        let Some(run) = &state.run else {
            return Vec::new();
        };
        let mut sources: Vec<_> = run.sources().collect();
        sources.sort_by_key(|(id, _)| Some(*id) != open);
        sources
            .into_iter()
            .map(|(_, source)| source.clone())
            .collect()
    }

    pub(super) fn network_changed(&self, net: LocalNetwork) {
        let mut state = self.state.lock_ok();
        state.network = Some(net);
        if let Some(run) = &state.run {
            for (_, source) in run.sources() {
                source.network_changed_with(net);
            }
        }
    }

    pub(super) fn retry(&self, id: HostId) -> Result<(), CommandError> {
        let result = {
            let _update = self.updates.lock_ok();
            let (context, host) = {
                let state = self.state.lock_ok();
                let run = state.run.as_ref().ok_or_else(not_started)?;
                let host = run.host(id).ok_or(CommandError::UnknownHost { host: id })?;
                if let Some(entry) = run.entries.get(&id) {
                    entry.source.retry();
                    return Ok(());
                }
                if run.retiring.contains_key(&id) {
                    return Err(connecting());
                }
                (run.context.clone(), host.clone())
            };
            let opened = self.open(&context, host);
            let mut state = self.state.lock_ok();
            let network = state.network;
            let run = state.run.as_mut().ok_or_else(not_started)?;
            let result = self.install(run, (id, opened), network);
            state.queue_roster();
            result
        };
        self.emit_rosters();
        result
    }

    fn emit_rosters(&self) {
        let mut state = self.state.lock_ok();
        if state.sending_roster {
            return;
        }
        state.sending_roster = true;
        while let Some(hosts) = state.roster_events.pop_front() {
            drop(state);
            emit(&*self.events, MobileEvent::HostsChanged { hosts });
            emit(&*self.events, MobileEvent::RemoteHostsChanged);
            state = self.state.lock_ok();
        }
        state.sending_roster = false;
    }
}

impl Run {
    fn detach(&mut self, id: HostId) {
        if let Some(entry) = self.entries.remove(&id) {
            entry.deactivate();
        }
    }

    fn entries(&self) -> impl Iterator<Item = &Arc<HostEntry>> {
        self.desired
            .iter()
            .filter_map(|host| self.entries.get(&host.id))
    }

    fn sources(&self) -> impl Iterator<Item = (HostId, &Arc<RemoteSource>)> {
        let current = self.entries().map(|entry| (entry.config.id, &entry.source));
        let draining = self.retiring.iter().filter_map(|(&id, source)| {
            source
                .as_ref()
                .filter(|_| !self.entries.contains_key(&id))
                .map(|source| (id, source))
        });
        current.chain(draining)
    }

    fn host(&self, id: HostId) -> Option<&MobileHost> {
        self.desired.iter().find(|host| host.id == id)
    }
}

impl State {
    fn queue_roster(&mut self) {
        if let Some(run) = &self.run {
            self.roster_events.push_back(run.records());
        }
    }
}

fn connecting() -> CommandError {
    CommandError::RemoteUnreachable {
        message: "The host session is still connecting".into(),
    }
}

fn validate(hosts: &[MobileHost]) -> Result<(), CommandError> {
    let mut ids = HashSet::with_capacity(hosts.len());
    for host in hosts {
        if !ids.insert(host.id) {
            return Err(invalid(format!("duplicate host {}", host.id)));
        }
        if host.targets.is_empty() || host.user.is_empty() {
            return Err(invalid(format!(
                "host {} needs a user and at least one target",
                host.id
            )));
        }
    }
    Ok(())
}

fn not_started() -> CommandError {
    internal("the mobile core has not started")
}

pub(super) fn emit(events: &dyn CoreEvents, event: MobileEvent) {
    match serde_json::to_string(&event) {
        Ok(json) => {
            callback("event", || events.event(json));
        }
        Err(error) => tracing::error!(%error, "serializing a mobile event"),
    }
}
