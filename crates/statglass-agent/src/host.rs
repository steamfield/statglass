//! This machine as the agent samples it: the in-process engine, its hub and the
//! combined collection interest of every connected session. The headless counterpart
//! of the app's `HostEntry`.
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::Context;
use statglass_engine::{
    EngineParts, HistoryStore, LiveHub, LocalSource, Source, SourceHandle, SourceSink,
};
use statglass_proto::{Answer, HostAddresses, RemoteInterest, RuleEntry};
use statglass_remote::addresses::AddressResolver;
use statglass_remote::{InterestSet, ServedHost, unsupported_query};
use statglass_schema::lock::LockExt;
use statglass_schema::{Capabilities, Event, HostRecord, Settings};
use statglass_store::Writer;
use uuid::Uuid;

use crate::alert_rules::AlertRuleStore;

pub struct AgentHost {
    record: HostRecord,
    source: Arc<LocalSource>,
    hub: LiveHub,
    addresses: AddressResolver,
    handle: Mutex<Option<SourceHandle>>,
    interests: Mutex<InterestSet>,
    alert_rules: Option<AlertRuleStore>,
}

impl AgentHost {
    /// Starts the engine for `record` with the given platform parts, into a new hub
    /// and, when history is available, `store`.
    pub fn start(
        record: HostRecord,
        settings: Settings,
        store: Option<Writer>,
        parts: EngineParts,
        data_dir: Option<PathBuf>,
        alert_history: Vec<Event>,
    ) -> anyhow::Result<Arc<Self>> {
        let source = Arc::new(LocalSource::new(record.clone(), parts, settings.clone()));
        source.seed_alert_history(alert_history);
        let hub = LiveHub::default();
        let handle = Arc::clone(&source)
            .start(SourceSink {
                live: hub.clone(),
                store,
            })
            .context("starting the engine")?;
        Ok(Arc::new(Self {
            record,
            source,
            hub,
            addresses: AddressResolver::default(),
            handle: Mutex::new(Some(handle)),
            interests: Mutex::default(),
            alert_rules: data_dir.map(|dir| AlertRuleStore::new(dir, settings)),
        }))
    }

    /// Stops the engine and waits for it: open buckets flush and open gaps close.
    /// Idempotent.
    pub fn stop(&self) {
        let handle = self.handle.lock_ok().take();
        if let Some(mut handle) = handle {
            handle.stop();
        }
    }

    /// Attaches the engine to a store that came back after starting without one, and
    /// returns once it is applied. A stopped engine has nothing to attach.
    pub fn attach_history(&self, history: &HistoryStore, writer: Writer) {
        if let Some((rules, control)) = self.alert_rules.as_ref().zip(self.source.engine()) {
            // Queue the seed before the attach so the first recorded tick has the cooldowns.
            rules.with_alerts(|alerts| {
                control.seed_alert_history(history.recent_alerts(
                    self.record.id,
                    statglass_engine::wall_ms(),
                    alerts,
                ));
            });
        }
        if let Some(handle) = self.handle.lock_ok().as_ref() {
            handle.control().set_store(Some(writer));
        }
    }

    /// What this process itself wants collected (`sample` asks for everything).
    pub fn set_local_interest(&self, interest: RemoteInterest) {
        self.change_interest(|all| all.local = interest);
    }

    fn change_interest(&self, update: impl FnOnce(&mut InterestSet)) {
        let mut all = self.interests.lock_ok();
        let previous = all.merged();
        update(&mut all);
        let interest = all.merged();
        // Applied under the interest lock, so a concurrent release cannot overwrite a
        // newer aggregate with an older one (as in the app's `HostEntry`).
        if let Some(handle) = self.handle.lock_ok().as_ref() {
            let control = handle.control();
            control.set_process_interest(interest.process_period_ms);
            control.set_network_process_interest(interest.network_processes);
            control.set_gpu_process_interest(interest.gpu_processes);
            control.set_port_process_interest(interest.port_processes);
            if interest.detail != previous.detail {
                control.set_detail_interest(interest.detail);
            }
        }
    }
}

impl ServedHost for AgentHost {
    fn record(&self) -> HostRecord {
        self.record.clone()
    }

    fn capabilities(&self) -> Capabilities {
        self.source.capabilities()
    }

    fn hub(&self) -> &LiveHub {
        &self.hub
    }

    fn serves_addresses(&self) -> bool {
        true
    }

    fn network_addresses(&self) -> HostAddresses {
        self.addresses.network_addresses(&self.hub)
    }

    fn set_remote_interest(&self, session: u64, interest: RemoteInterest) {
        self.change_interest(|all| all.set_remote(session, interest));
    }

    fn alert_rules(&self) -> Answer {
        self.alert_rules
            .as_ref()
            .map_or_else(unsupported_query, |store| {
                Answer::AlertRules(store.current())
            })
    }

    fn set_alert_rules(
        &self,
        base_revision: i64,
        rules: Vec<RuleEntry>,
        keep: Vec<Uuid>,
    ) -> Answer {
        let Some(store) = &self.alert_rules else {
            return unsupported_query();
        };
        store.replace(base_revision, rules, keep, |settings| {
            if let Some(handle) = self.handle.lock_ok().as_ref() {
                handle.control().apply_settings(settings);
            }
        })
    }
}

impl Drop for AgentHost {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
#[path = "host_alert_tests.rs"]
mod alert_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use statglass_engine::{FakeTicker, NoPowerSignals};
    use statglass_schema::{HostId, HostInfo, OsKind};
    use std::time::Duration;

    #[test]
    fn overlapping_sessions_release_the_actual_engine_detail_demand() {
        let record = HostRecord {
            id: HostId(uuid::Uuid::from_u128(7)),
            is_local: true,
            display_name: "test agent".into(),
            info: HostInfo {
                os: OsKind::Linux,
                os_version: String::new(),
                model: None,
                chip: None,
                chip_known: false,
                cpu_topology: Vec::new(),
                mem_total_bytes: 0,
                boot_time_ms: 0,
                gpu_dvfs_mhz: Vec::new(),
                kernel: None,
                boot_mounts: Vec::new(),
            },
        };
        let (ticker, _clock) = FakeTicker::new();
        let source = Arc::new(LocalSource::new(
            record.clone(),
            EngineParts {
                collectors: Vec::new(),
                ticker: Box::new(ticker),
                power: Box::new(NoPowerSignals),
                hints: None,
            },
            Settings::default(),
        ));
        let hub = LiveHub::default();
        let handle = Arc::clone(&source)
            .start(SourceSink {
                live: hub.clone(),
                store: None,
            })
            .unwrap();
        let host = AgentHost {
            record,
            source,
            hub,
            addresses: AddressResolver::default(),
            handle: Mutex::new(Some(handle)),
            interests: Mutex::default(),
            alert_rules: None,
        };
        let control = host.source.engine().unwrap();
        let detail = RemoteInterest {
            detail: true,
            ..RemoteInterest::default()
        };
        assert_eq!(control.detail_interest(), 0);
        host.set_remote_interest(1, detail.clone());
        assert_eq!(control.detail_interest(), 1);
        host.set_remote_interest(1, detail.clone());
        assert_eq!(
            control.detail_interest(),
            1,
            "repeated interest is idempotent"
        );
        host.set_remote_interest(2, detail.clone());
        assert_eq!(control.detail_interest(), 1, "sessions share one aggregate");
        host.set_local_interest(RemoteInterest {
            process_period_ms: Some(1000),
            network_processes: true,
            ..RemoteInterest::default()
        });
        assert_eq!(
            control.detail_interest(),
            1,
            "other interests add no demand"
        );
        host.set_remote_interest(1, RemoteInterest::default());
        assert_eq!(
            control.detail_interest(),
            1,
            "the second session still watches"
        );
        host.set_remote_interest(2, RemoteInterest::default());
        assert_eq!(
            control.detail_interest(),
            0,
            "the final session releases detail"
        );
        // Detail release publishes status asynchronously. Wait for the following
        // engine command to finish before checking the published mode.
        control
            .set_store(None)
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        assert!(control.status().backgrounded);
        assert_eq!(control.process_interest(), Some(1000));

        host.set_local_interest(detail.clone());
        host.set_remote_interest(3, detail);
        host.set_local_interest(RemoteInterest::default());
        assert_eq!(
            control.detail_interest(),
            1,
            "remote demand outlives local demand"
        );
        host.set_remote_interest(3, RemoteInterest::default());
        host.set_remote_interest(3, RemoteInterest::default());
        assert_eq!(control.detail_interest(), 0);
        // Detail release publishes status asynchronously. Wait for the following
        // engine command to finish before checking the published mode.
        control
            .set_store(None)
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        assert!(control.status().backgrounded);
        host.stop();
    }
}
