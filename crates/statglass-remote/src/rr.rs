//! Controller-side observation of rr locks; never part of the agent protocol.
use serde::{Deserialize, Serialize};
use statglass_schema::HostId;
use std::collections::BTreeMap;

pub const LOCK_DIR: &str = "/tmp/rr.lock";
pub const MAX_BYTES: u64 = 4096;
/// Constant paths only. Test file type before opening so a FIFO never blocks.
pub const SCRIPT: &str = "if [ ! -L /tmp/rr.lock ] && [ -f /tmp/rr.lock/info.json ] && [ ! -L /tmp/rr.lock/info.json ]; then head -c 4096 /tmp/rr.lock/info.json; fi";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct RrJob {
    pub command: Option<String>,
    pub user: String,
    pub client_hostname: String,
    #[specta(type = statglass_schema::JsSafeInt)]
    pub started_ms: i64,
    pub peers: Vec<HostId>,
}

#[derive(Deserialize)]
struct LockInfo {
    command: Option<String>,
    user: String,
    hostname: String,
    started: String,
}

pub fn parse(bytes: &[u8], login: &str) -> Option<RrJob> {
    let info: LockInfo = match serde_json::from_slice(bytes) {
        Ok(info) => info,
        Err(error) => {
            if !bytes.is_empty() {
                tracing::debug!(%error, "invalid rr lock JSON");
            }
            return None;
        }
    };
    if info.user != login || login.is_empty() {
        return None;
    }
    let Ok(started) = info.started.parse::<jiff::Timestamp>() else {
        tracing::debug!("invalid rr lock start timestamp");
        return None;
    };
    Some(RrJob {
        command: info.command.map(|s| s.chars().take(200).collect()),
        user: info.user,
        client_hostname: info.hostname,
        started_ms: started.as_millisecond(),
        peers: vec![],
    })
}

pub fn group(jobs: &mut BTreeMap<HostId, RrJob>) {
    let peers: Vec<_> = jobs
        .iter()
        .map(|(id, job)| {
            let peers = jobs
                .iter()
                .filter_map(|(other, candidate)| {
                    (id != other
                        && job.user == candidate.user
                        && job.client_hostname == candidate.client_hostname
                        && job.started_ms.abs_diff(candidate.started_ms) <= 10_000)
                        .then_some(*other)
                })
                .collect();
            (*id, peers)
        })
        .collect();
    for (id, peers) in peers {
        if let Some(job) = jobs.get_mut(&id) {
            job.peers = peers;
        }
    }
}

/// Resolve OpenSSH's configured login locally; this does not connect to the host.
async fn login(alias: &str) -> crate::Result<String> {
    let command = crate::ssh_command(alias)?;
    // -G must precede the destination (ssh_command ends with `-- alias`).
    let mut args: Vec<_> = command.as_std().get_args().map(|s| s.to_owned()).collect();
    args.insert(0, "-G".into());
    let output = tokio::process::Command::new("/usr/bin/ssh")
        .args(args)
        .kill_on_drop(true)
        .output()
        .await?;
    if !output.status.success() {
        return Err(crate::RemoteError::Transport("resolving SSH login".into()));
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.strip_prefix("user ").map(str::to_owned))
        .filter(|user| !user.is_empty())
        .ok_or_else(|| crate::RemoteError::Protocol("SSH configuration has no login user".into()))
}

pub async fn read(alias: &str) -> crate::Result<Option<RrJob>> {
    let user = login(alias).await?;
    let command = crate::transport::sh_c(SCRIPT)?;
    let text = crate::install::run_remote(alias, &command).await?;
    Ok(parse(text.as_bytes(), &user))
}

#[cfg(unix)]
mod local;
#[cfg(unix)]
pub use local::read_local;
#[cfg(test)]
mod tests;
