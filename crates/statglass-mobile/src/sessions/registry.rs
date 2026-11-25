use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};

use statglass_engine::Source;
use statglass_ipc::error::CommandError;
use statglass_ipc::mobile::{MobileEvent, MobileHost};
use statglass_schema::{HostId, HostRecord, lock::LockExt};
use statglass_session::network::LocalNetwork;
use statglass_session::{Dialer, RemoteSource, SourceOptions, SyncPolicy};
use tokio::runtime::Handle;

use crate::ffi::CoreEvents;

use super::{callback, host::HostEntry, internal, invalid, live::Live, phone_id};

pub(super) struct Registry {
    pub(super) events: Arc<dyn CoreEvents>,
    pub(super) live: Arc<Live>,
    // Serializes roster edits while new mirrors open outside the state lock.
    updates: Mutex<()>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    run: Option<Run>,
    policy: Option<SyncPolicy>,
    network: Option<LocalNetwork>,
    recent: bool,
    roster_events: VecDeque<Vec<HostRecord>>,
    sending_roster: bool,
}

struct Run {
    context: Context,
    desired: Vec<MobileHost>,
    entries: HashMap<HostId, Arc<HostEntry>>,
    // A removal or rebuild owns the path until it has closed the old mirror.
    // Keep the source visible to lifecycle drains while it can still be writing.
    retiring: HashMap<HostId, Option<Arc<RemoteSource>>>,
}

#[derive(Clone)]
struct Context {
    runtime: Handle,
    data_dir: PathBuf,
    phone: HostId,
    dialer: Arc<dyn Dialer>,
    sync: SyncPolicy,
}

impl Context {
    fn open(
        &self,
        host: MobileHost,
        budget: u32,
        events: Arc<dyn CoreEvents>,
    ) -> Result<Arc<HostEntry>, CommandError> {
        HostEntry::open(
            host,
            budget,
            &self.data_dir,
            self.phone,
            self.dialer.clone(),
            events,
            SourceOptions {
                runtime: Some(self.runtime.clone()),
                sync: self.sync,
                ..Default::default()
            },
        )
    }
}

impl Registry {
    pub(super) fn new(events: Arc<dyn CoreEvents>) -> Self {
        Self {
            events,
            live: Arc::default(),
            updates: Mutex::default(),
            state: Mutex::default(),
        }
    }

    pub(super) fn start(
        self: &Arc<Self>,
        runtime: Handle,
        data_dir: PathBuf,
        hosts: Vec<MobileHost>,
        dialer: Arc<dyn Dialer>,
        sync: SyncPolicy,
    ) -> Result<(), CommandError> {
        {
            let _update = self.updates.lock_ok();
            if self.state.lock_ok().run.is_some() {
                return Err(invalid("the mobile core has already started"));
            }
            validate(&hosts)?;
            let mut run = Run {
                context: Context {
                    phone: phone_id::load(&data_dir)?,
                    runtime,
                    data_dir,
                    dialer,
                    sync,
                },
                desired: Vec::new(),
                entries: HashMap::new(),
                retiring: HashMap::new(),
            };
            let new = self.open_hosts(&run.context, &hosts, hosts.len())?;
            let mut state = self.state.lock_ok();
            self.apply_hosts(&mut run, hosts, new, state.controls(sync))?;
            state.run = Some(run);
            state.queue_roster();
        }
        self.emit_rosters();
        Ok(())
    }

    pub(super) fn set_hosts(
        self: &Arc<Self>,
        hosts: Vec<MobileHost>,
        sync: SyncPolicy,
    ) -> Result<(), CommandError> {
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
            let new = self.open_hosts(&context, &missing, hosts.len())?;
            let mut state = self.state.lock_ok();
            let controls = state.controls(sync);
            let run = state.run.as_mut().ok_or_else(not_started)?;
            self.apply_hosts(run, hosts, new, controls)?;
            state.queue_roster();
        }
        self.emit_rosters();
        Ok(())
    }

    fn open_hosts(
        &self,
        context: &Context,
        hosts: &[MobileHost],
        count: usize,
    ) -> Result<Vec<Arc<HostEntry>>, CommandError> {
        let budget = crate::policy::host_budget_mb(count);
        hosts
            .iter()
            .map(|host| context.open(host.clone(), budget, self.events.clone()))
            .collect()
    }

    fn apply_hosts(
        self: &Arc<Self>,
        run: &mut Run,
        hosts: Vec<MobileHost>,
        new: Vec<Arc<HostEntry>>,
        controls: Controls,
    ) -> Result<(), CommandError> {
        for entry in &new {
            controls.apply(&entry.source);
            entry.start()?;
        }

        run.context.sync = controls.sync;
        run.desired = hosts;
        for entry in new {
            self.install(run, entry);
        }

        let budget = run.budget();
        let retiring: Vec<_> = run
            .entries
            .values()
            .filter(|entry| {
                run.host(entry.config.id)
                    .is_none_or(|host| host != &entry.config || budget != entry.policy.budget_mb())
            })
            .cloned()
            .collect();
        for entry in retiring {
            let id = entry.config.id;
            if run.host(id).is_none() {
                self.detach(run, id);
            }
            if let std::collections::hash_map::Entry::Vacant(slot) = run.retiring.entry(id) {
                slot.insert(Some(entry.source.clone()));
                self.retire(&run.context.runtime, entry);
            }
        }
        Ok(())
    }

    fn install(&self, run: &mut Run, entry: Arc<HostEntry>) {
        self.live.register(entry.clone());
        run.entries.insert(entry.config.id, entry);
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
                registry.detach(run, id);
            }
            // Dropping the handle stops the runner. Wait for any write that
            // a concurrent resume began before releasing the writer lock.
            drop(entry.handle.lock_ok().take());
            entry.source.quiesce().await;
            if let Some(registry) = registry.upgrade()
                && let Some(run) = registry.state.lock_ok().run.as_mut()
            {
                run.retiring.insert(id, None);
            }
            let finished = tokio::task::spawn_blocking(move || {
                entry.close_history();
                Self::replace_retired(registry, id);
            })
            .await;
            if let Err(error) = finished {
                tracing::error!(%id, %error, "closing a mobile mirror");
            }
        });
    }

    fn detach(&self, run: &mut Run, id: HostId) {
        if let Some(entry) = run.entries.remove(&id) {
            entry.deactivate();
            self.live.remove_host(id);
        }
    }

    fn replace_retired(registry: Weak<Self>, id: HostId) {
        let Some(registry) = registry.upgrade() else {
            return;
        };
        loop {
            let (context, host, budget) = {
                let _update = registry.updates.lock_ok();
                let mut state = registry.state.lock_ok();
                let Some(run) = state.run.as_mut() else {
                    return;
                };
                let Some(host) = run.host(id).cloned() else {
                    run.retiring.remove(&id);
                    return;
                };
                (run.context.clone(), host, run.budget())
            };
            let opened = context.open(host.clone(), budget, registry.events.clone());
            let update = registry.updates.lock_ok();
            let mut state = registry.state.lock_ok();
            let controls = state.controls(context.sync);
            let Some(run) = state.run.as_mut() else {
                return;
            };
            if run.host(id) != Some(&host) || run.budget() != budget {
                continue;
            }
            run.retiring.remove(&id);
            let result = opened.and_then(|entry| {
                controls.apply(&entry.source);
                entry.start()?;
                registry.install(run, entry);
                Ok(())
            });
            if let Err(error) = result {
                tracing::error!(%id, %error, "rebuilding mobile mirror");
            }
            state.queue_roster();
            drop(state);
            drop(update);
            registry.emit_rosters();
            return;
        }
    }

    pub(super) fn entries(&self) -> Result<Vec<Arc<HostEntry>>, CommandError> {
        let state = self.state.lock_ok();
        let run = state.run.as_ref().ok_or_else(not_started)?;
        Ok(run.entries().cloned().collect())
    }

    pub(super) fn entry(&self, host: HostId) -> Result<Arc<HostEntry>, CommandError> {
        let state = self.state.lock_ok();
        let run = state.run.as_ref().ok_or_else(not_started)?;
        run.entries
            .get(&host)
            .cloned()
            .ok_or(CommandError::UnknownHost { host })
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

    pub(super) fn set_sync_policy(&self, policy: SyncPolicy) {
        let mut state = self.state.lock_ok();
        state.policy = Some(policy);
        if let Some(run) = &mut state.run {
            run.context.sync = policy;
            for (_, source) in run.sources() {
                source.set_sync_policy(policy);
            }
        }
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

    pub(super) fn set_recent_interest(&self, on: bool) -> Result<(), CommandError> {
        let mut state = self.state.lock_ok();
        let run = state.run.as_ref().ok_or_else(not_started)?;
        for entry in run.entries.values() {
            entry.source.set_recent_interest(on);
        }
        state.recent = on;
        Ok(())
    }

    pub(super) fn records(&self) -> Result<Vec<HostRecord>, CommandError> {
        Ok(self
            .entries()?
            .iter()
            .map(|entry| entry.source.host())
            .collect())
    }

    pub(super) fn retry(&self, id: HostId) -> Result<(), CommandError> {
        {
            let _update = self.updates.lock_ok();
            let (context, host, budget) = {
                let state = self.state.lock_ok();
                let run = state.run.as_ref().ok_or_else(not_started)?;
                if let Some(entry) = run.entries.get(&id) {
                    entry.source.retry();
                    return Ok(());
                }
                let host = run
                    .host(id)
                    .filter(|_| !run.retiring.contains_key(&id))
                    .ok_or(CommandError::UnknownHost { host: id })?;
                (run.context.clone(), host.clone(), run.budget())
            };
            let entry = context.open(host, budget, self.events.clone())?;
            let mut state = self.state.lock_ok();
            state.controls(context.sync).apply(&entry.source);
            entry.start()?;
            let run = state.run.as_mut().ok_or_else(not_started)?;
            self.install(run, entry);
            state.queue_roster();
        }
        self.emit_rosters();
        Ok(())
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

    fn budget(&self) -> u32 {
        crate::policy::host_budget_mb(self.desired.len())
    }
}

#[derive(Clone, Copy)]
struct Controls {
    sync: SyncPolicy,
    network: Option<LocalNetwork>,
    recent: bool,
}

impl State {
    fn queue_roster(&mut self) {
        if let Some(run) = &self.run {
            self.roster_events
                .push_back(run.entries().map(|entry| entry.source.host()).collect());
        }
    }

    fn controls(&self, sync: SyncPolicy) -> Controls {
        Controls {
            sync: self.policy.unwrap_or(sync),
            network: self.network,
            recent: self.recent,
        }
    }
}

impl Controls {
    fn apply(self, source: &RemoteSource) {
        source.set_sync_policy(self.sync);
        if let Some(network) = self.network {
            source.network_changed_with(network);
        }
        source.set_recent_interest(self.recent);
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
