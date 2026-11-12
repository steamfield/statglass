//! `run`: the daemon. It owns the engine and the history store (their single writer)
//! and serves both on the metrics socket until SIGTERM or SIGINT.
use std::path::Path;
use std::sync::Arc;

use anyhow::Context;
use statglass_engine::disk_space::SpaceService;
use statglass_engine::{HistoryStore, identity, retention_for};
use statglass_remote::{AgentPaths, HostServer};
use statglass_schema::{HostId, HostRecord};
use statglass_store::Writer;
use tokio::signal::unix::{SignalKind, signal};

use crate::host::AgentHost;

/// The binding that ties a host id to this machine (D-116). Linux binds to
/// `/etc/machine-id`, plus the firmware id for the system agent; macOS uses the
/// hardware UUID as the app does.
pub fn binding(system: bool) -> impl Fn(HostId) -> Option<String> {
    move |id| platform_binding(id, system)
}

#[cfg(target_os = "linux")]
fn platform_binding(id: HostId, system: bool) -> Option<String> {
    let scope = if system {
        identity::BindingScope::WithHardware
    } else {
        identity::BindingScope::MachineId
    };
    identity::linux_binding(id, Path::new("/"), scope)
}

#[cfg(not(target_os = "linux"))]
fn platform_binding(id: HostId, _system: bool) -> Option<String> {
    identity::machine_binding(id)
}

pub async fn run(paths: &AgentPaths, system: bool) -> anyhow::Result<()> {
    check_socket_dir(&paths.socket)?;
    let (history, id) = identity::open_local(&paths.data_dir, binding(system));
    let record = statglass_engine::host_record(id.id);
    let settings = crate::settings::load(&paths.data_dir);
    tracing::info!(
        host = %id.id,
        id_source = ?id.source,
        id_persisted = id.persisted,
        name = %record.display_name,
        os = %record.info.os_version,
        data_dir = %paths.data_dir.display(),
        socket = %paths.socket.display(),
        retention_days = settings.history.retention_days,
        size_limit_mb = settings.history.size_limit_mb,
        "statglass-agent {} starting",
        env!("CARGO_PKG_VERSION"),
    );
    // A store that cannot take the host leaves history unavailable; the agent still
    // serves live data (D-064).
    let writer = history.register_host(&record);
    if writer.is_none() {
        tracing::warn!("history unavailable; serving live data only");
    }
    let names = crate::container_names::spawn();
    crate::container_names::first_pass(&names, crate::container_names::FIRST_PASS_WITHIN).await;
    let host = AgentHost::start(record.clone(), settings.clone(), writer, names)?;
    let budget = settings.history;
    let housekeeping = history
        .spawn_pruner(
            move || retention_for(&budget),
            |health| tracing::info!(?health, "history health"),
        )
        .context("starting history housekeeping")?;
    let history = Arc::new(history);
    let retry = tokio::spawn(retry_history(
        Arc::clone(&history),
        Arc::clone(&host),
        record,
    ));
    let result = serve_until_signal(&paths.socket, Arc::clone(&host), history).await;
    retry.abort();
    // The socket is gone once the server returns; now the engine closes its buckets
    // and gaps. Stopping waits on the engine thread, so off the runtime's workers.
    let stopping = Arc::clone(&host);
    tokio::task::spawn_blocking(move || stopping.stop())
        .await
        .context("stopping the engine")?;
    drop(housekeeping);
    tracing::info!("statglass-agent stopped");
    result
}

/// How often a history that failed to open (a full disk at start, another process
/// holding the file) is tried again.
const HISTORY_RETRY: std::time::Duration = std::time::Duration::from_secs(60);

/// Retries a history store that is unavailable for a reason that can clear up, and
/// attaches the engine to it once it opens. A store that is open does nothing here.
async fn retry_history(history: Arc<HistoryStore>, host: Arc<AgentHost>, record: HostRecord) {
    let mut every = tokio::time::interval(HISTORY_RETRY);
    every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    every.tick().await;
    loop {
        every.tick().await;
        let (history, host, record) = (Arc::clone(&history), Arc::clone(&host), record.clone());
        let attempt = tokio::task::spawn_blocking(move || {
            reattach(&history, &record, |writer| host.set_store(Some(writer)))
        });
        if let Err(e) = attempt.await {
            tracing::error!("history retry stopped: {e}");
            return;
        }
    }
}

/// One retry: reopens the store and, when it opens and takes the host, hands the writer
/// to `attach`. Returns whether history came back.
fn reattach(history: &HistoryStore, record: &HostRecord, attach: impl FnOnce(Writer)) -> bool {
    match history.reopen() {
        Ok(None) => false,
        Err(e) => {
            tracing::warn!("history still unavailable: {e}");
            false
        }
        Ok(Some(_)) => match history.register_host(record) {
            Some(writer) => {
                attach(writer);
                tracing::info!("history reopened; recording again");
                true
            }
            None => false,
        },
    }
}

/// The metrics server makes the socket's directory owner-only. Pointed at a shared
/// directory (`--socket /tmp/x.sock`, as root) that would lock everyone else out of it,
/// so a shared parent is refused before anything starts.
fn check_socket_dir(socket: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let parent = socket
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .context("the socket path needs a directory")?;
    match std::fs::metadata(parent) {
        Ok(meta) if meta.permissions().mode() & 0o1002 != 0 => anyhow::bail!(
            "{} is shared (world-writable or sticky); put the socket in a directory of its own",
            parent.display()
        ),
        _ => Ok(()),
    }
}

async fn serve_until_signal(
    socket: &Path,
    host: Arc<AgentHost>,
    history: Arc<HistoryStore>,
) -> anyhow::Result<()> {
    let mut term = signal(SignalKind::terminate()).context("installing the SIGTERM handler")?;
    let mut int = signal(SignalKind::interrupt()).context("installing the SIGINT handler")?;
    let (stop, stopped) = tokio::sync::watch::channel(false);
    let server = statglass_remote::serve_metrics(
        socket.to_path_buf(),
        Arc::new(HostServer::new(host, history).with_space(Arc::new(SpaceService::new()))),
        stopped,
    );
    tokio::pin!(server);
    tokio::select! {
        result = &mut server => {
            return result.with_context(|| format!("serving {}", socket.display()));
        }
        _ = term.recv() => tracing::info!("SIGTERM: stopping"),
        _ = int.recv() => tracing::info!("SIGINT: stopping"),
    }
    let _ = stop.send(true);
    server
        .await
        .with_context(|| format!("serving {}", socket.display()))
}

/// `serve --stdio`: bridges this SSH session to the daemon. A missing or refused socket
/// is [`statglass_remote::AGENT_NOT_RUNNING`] and exit status 3, which the controller
/// reports as "agent not running".
pub async fn serve(socket: &Path) -> anyhow::Result<std::process::ExitCode> {
    match statglass_remote::stdio_bridge(socket).await {
        Ok(()) => Ok(std::process::ExitCode::SUCCESS),
        Err(e) if not_running(&e) => {
            eprintln!("{}", statglass_remote::AGENT_NOT_RUNNING);
            Ok(std::process::ExitCode::from(3))
        }
        Err(e) => Err(e).with_context(|| format!("bridging {}", socket.display())),
    }
}

/// Connect errors that mean no daemon is listening (a stale socket file refuses).
pub fn not_running(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_socket_directories_are_refused() {
        assert!(check_socket_dir(Path::new("/tmp/x.sock")).is_err());
        assert!(check_socket_dir(Path::new("x.sock")).is_err());
        let dir = tempfile::tempdir().unwrap();
        assert!(check_socket_dir(&dir.path().join("x.sock")).is_ok());
        // A directory that does not exist yet is created private by the server.
        assert!(check_socket_dir(&dir.path().join("new/x.sock")).is_ok());
    }

    #[test]
    fn a_retry_reattaches_history_once_the_file_can_open() {
        if crate::test_support::reexec_for_lock_test() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join(statglass_engine::HISTORY_DB_FILE);
        std::fs::create_dir(&db).unwrap();
        let history = HistoryStore::open(dir.path());
        let record = statglass_engine::host_record(HostId(uuid::Uuid::from_u128(9)));
        assert!(history.register_host(&record).is_none());
        let attached = std::cell::Cell::new(0);
        let attach = |_: Writer| attached.set(attached.get() + 1);

        assert!(!reattach(&history, &record, attach), "still in the way");
        std::fs::remove_dir(&db).unwrap();
        assert!(reattach(&history, &record, attach));
        assert!(!reattach(&history, &record, attach), "already open");
        assert_eq!(attached.get(), 1);
        assert_eq!(history.read(|r| r.hosts()).unwrap(), vec![record]);
        history.close();
    }

    #[test]
    fn missing_or_refused_sockets_mean_not_running() {
        assert!(not_running(&std::io::ErrorKind::NotFound.into()));
        assert!(not_running(&std::io::ErrorKind::ConnectionRefused.into()));
        assert!(!not_running(&std::io::ErrorKind::BrokenPipe.into()));
    }
}
