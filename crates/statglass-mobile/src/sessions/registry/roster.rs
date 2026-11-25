use std::sync::Arc;

use statglass_engine::Source;
use statglass_ipc::error::CommandError;
use statglass_ipc::mobile::MobileRemoteHost;
use statglass_schema::{HostRecord, lock::LockExt};

use super::{Registry, Run, not_started};
use crate::sessions::{
    endpoint,
    host::{HostEntry, unopened_host},
};

enum RemoteHostRow {
    Running(Arc<HostEntry>),
    Unopened(Box<MobileRemoteHost>),
}

impl Registry {
    pub(in crate::sessions) fn remote_hosts(&self) -> Result<Vec<MobileRemoteHost>, CommandError> {
        let rows = {
            let state = self.state.lock_ok();
            let run = state.run.as_ref().ok_or_else(not_started)?;
            run.desired
                .iter()
                .map(|host| {
                    let row = match run.entries.get(&host.id) {
                        Some(entry) => RemoteHostRow::Running(entry.clone()),
                        None => RemoteHostRow::Unopened(Box::new(unopened_host(
                            host,
                            run.open_errors.get(&host.id),
                        ))),
                    };
                    (
                        row,
                        run.store.controllers.get(&host.id).copied(),
                        host.removed_by_controller,
                    )
                })
                .collect::<Vec<_>>()
        };
        Ok(rows
            .into_iter()
            .map(|(row, source_mac, removed)| {
                let mut host = match row {
                    RemoteHostRow::Running(entry) => entry.remote_host(),
                    RemoteHostRow::Unopened(host) => *host,
                };
                host.source_mac = source_mac;
                host.removed_by_controller = removed;
                host
            })
            .collect())
    }

    pub(in crate::sessions) fn records(&self) -> Result<Vec<HostRecord>, CommandError> {
        let state = self.state.lock_ok();
        Ok(state.run.as_ref().ok_or_else(not_started)?.records())
    }
}

impl Run {
    pub(super) fn records(&self) -> Vec<HostRecord> {
        self.desired
            .iter()
            .map(|host| {
                self.entries
                    .get(&host.id)
                    .map_or_else(|| endpoint::record(host), |entry| entry.source.host())
            })
            .collect()
    }
}
