//! Retries this Mac's history store when it failed to open for a reason that can clear
//! up (a full disk at launch, another process holding the lock), so the app records
//! again without a relaunch or a reset. A damaged or newer file still needs the reset.
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use super::History;
use crate::ipc::HistoryHealth;
use crate::{AppState, CommandError, HostEntry};

const EVERY: Duration = Duration::from_secs(60);

/// Checks the store once a minute for the app's lifetime. An open store costs one
/// availability check; a closed one (at quit) is never reopened.
pub fn spawn(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("history-retry".into())
        .spawn(move || {
            loop {
                std::thread::sleep(EVERY);
                if let Some(state) = app.try_state::<AppState>()
                    && !state.history.is_available()
                {
                    retry(&state, &app);
                }
            }
        });
    if let Err(e) = spawned {
        tracing::warn!("starting the history retry: {e}");
    }
}

fn retry(state: &AppState, app: &AppHandle) {
    let hosts: Vec<_> = state
        .hosts
        .all()
        .into_iter()
        .filter(|h| h.record().is_local)
        .collect();
    match reattach(&state.history, &hosts) {
        Ok(None) => {}
        Err(e) => tracing::warn!("history still unavailable: {e}"),
        Ok(Some(health)) => {
            if let Ok(writer) = state.history.writer()
                && let Ok(dir) = app.path().app_data_dir()
            {
                state
                    .docker
                    .recorder
                    .attach(writer, dir.join(super::DB_FILE));
            }
            // Windows showing the unavailable banner ask again and find history back.
            state.emit_history_health(app, health);
            tracing::info!("history reopened; recording again");
        }
    }
}

/// One retry: reopens the store and attaches every local host to it, registering each.
/// The health to announce once history is back; `Ok(None)` when there was nothing to
/// reopen.
fn reattach(
    history: &History,
    hosts: &[Arc<HostEntry>],
) -> Result<Option<HistoryHealth>, CommandError> {
    history.reopen_and_attach(|history| {
        for h in hosts {
            h.set_store(history.register_host(&h.record()));
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::HostRegistry;
    use statglass_schema::{Capabilities, HostRecord};

    /// A source that is never started: the retry only needs the entry's record.
    struct Unstarted(HostRecord);

    impl statglass_engine::Source for Unstarted {
        fn host(&self) -> HostRecord {
            self.0.clone()
        }
        fn capabilities(&self) -> Capabilities {
            Capabilities::default()
        }
        fn start(
            self: Arc<Self>,
            _: statglass_engine::SourceSink,
        ) -> Result<statglass_engine::SourceHandle, statglass_engine::SourceError> {
            Err(statglass_engine::SourceError::AlreadyStarted)
        }
    }

    /// The m1-linux failure on this Mac: the store could not open at launch, so the app
    /// ran live-only until a relaunch. Once the cause clears, a retry brings history
    /// back with the host registered, and later retries leave the open store alone.
    #[test]
    fn a_store_that_failed_at_launch_comes_back_with_the_host_registered() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join(super::super::DB_FILE);
        std::fs::create_dir(&db).unwrap();
        let history = History::open(tmp.path());
        assert!(!history.is_available());
        let record = crate::test_support::mac_host(5);
        let registry = HostRegistry::new();
        let entry = registry.insert(record.clone(), Arc::new(Unstarted(record.clone())));
        let hosts = [entry];

        assert!(reattach(&history, &hosts).is_err(), "still in the way");
        assert!(!history.is_available());

        std::fs::remove_dir(&db).unwrap();
        let health = reattach(&history, &hosts).unwrap();
        assert!(health.is_some(), "history came back");
        assert!(history.is_available());
        assert_eq!(history.read(|r| r.hosts()).unwrap(), vec![record]);
        assert_eq!(reattach(&history, &hosts).unwrap(), None, "already open");
        history.close();
    }

    /// A damaged file is left for the user's reset: retrying would only fail the same
    /// way, and the banner's Reset history is the way out.
    #[test]
    fn a_damaged_store_waits_for_a_reset() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(super::super::DB_FILE), b"not a database").unwrap();
        let history = History::open(tmp.path());
        assert!(!history.is_available());
        assert_eq!(reattach(&history, &[]).unwrap(), None);
        assert!(!history.is_available());
    }
}
