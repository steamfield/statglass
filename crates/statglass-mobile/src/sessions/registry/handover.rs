use std::sync::Arc;

use statglass_ipc::{error::CommandError, mobile::MobileHost};
use statglass_schema::{HostId, lock::LockExt};

use crate::{handover::PendingHandover, host_store::HostStore, sessions::current_device_key};

use super::{Registry, internal, not_started, validate_hosts};

impl Registry {
    pub(in crate::sessions) fn update_hosts<T>(
        self: &Arc<Self>,
        pairing: Option<(HostId, &[u8])>,
        change: impl FnOnce(
            HostId,
            &mut Vec<MobileHost>,
            &mut HostStore,
            &mut Option<PendingHandover>,
        ) -> Result<T, CommandError>,
    ) -> Result<T, CommandError> {
        let result = {
            let _update = self.updates.lock_ok();
            let (context, mut store, hosts, missing, handover, result) = {
                let state = self.state.lock_ok();
                let run = state.run.as_ref().ok_or_else(not_started)?;
                let mut hosts = run.desired.clone();
                let mut store = run.store.clone();
                let mut handover = state.handover.clone();
                let result = change(run.context.phone, &mut hosts, &mut store, &mut handover)?;
                validate_hosts(&hosts)?;
                store
                    .controllers
                    .retain(|id, _| hosts.iter().any(|host| host.id == *id));
                let missing: Vec<_> = hosts
                    .iter()
                    .filter(|host| {
                        !run.entries.contains_key(&host.id) && !run.retiring.contains_key(&host.id)
                    })
                    .cloned()
                    .collect();
                (run.context.clone(), store, hosts, missing, handover, result)
            };
            if let Some((_, key)) = pairing {
                store = store.with_device_key(key);
            } else if !hosts.is_empty()
                && !store.has_device_key()
                && let Some(key) = current_device_key(self.signer.as_deref())?
            {
                store = store.with_device_key(&key);
            }
            let new = self.open_hosts(&context, &missing);
            // Commit the staged roster before publishing it or starting new sources.
            // A failed save leaves the previous sessions, including a re-paired host, intact.
            store.save(&hosts)?;
            let mut state = self.state.lock_ok();
            let network = state.network;
            let run = state.run.as_mut().ok_or_else(not_started)?;
            let re_paired = pairing
                .map(|(id, _)| id)
                .filter(|id| run.entries.contains_key(id));
            run.store = store;
            self.apply_hosts(run, hosts, new, network, re_paired);
            state.handover = handover;
            state.queue_roster();
            result
        };
        self.emit_rosters();
        Ok(result)
    }

    pub(in crate::sessions) fn stage_handover<T>(
        &self,
        stage: impl FnOnce(
            u32,
            HostId,
            &[MobileHost],
            &HostStore,
        ) -> Result<(PendingHandover, T), CommandError>,
    ) -> Result<T, CommandError> {
        let _update = self.updates.lock_ok();
        let mut state = self.state.lock_ok();
        let run = state.run.as_ref().ok_or_else(not_started)?;
        let id = state
            .handover_id
            .checked_add(1)
            .ok_or_else(|| internal("no more host bundle preview IDs"))?;
        let (handover, result) = stage(id, run.context.phone, &run.desired, &run.store)?;
        state.handover_id = id;
        state.handover = Some(handover);
        Ok(result)
    }
}
