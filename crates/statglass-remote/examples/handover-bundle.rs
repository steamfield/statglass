use std::{
    io,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use statglass_engine::wall_ms;
use statglass_proto::handover::{HostBundle, encode_bundle};
use statglass_remote::{
    DeviceTag, EcdsaP256Public,
    agent_install::AgentStatus,
    command::shell_quote,
    intents::{IntentLog, IntentOp},
    ssh_config::{HandoverInput, handover_host},
};
use statglass_schema::HostId;
use tokio::process::Command;
use uuid::Uuid;

const USAGE: &str = "usage: handover-bundle --ssh-config PATH --alias ALIAS --key KEY";

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut config = None;
    let mut alias = None;
    let mut key = None;
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        let slot = match flag.as_str() {
            "--ssh-config" => &mut config,
            "--alias" => &mut alias,
            "--key" => &mut key,
            _ => return Err(USAGE.into()),
        };
        if slot.is_some() {
            return Err(USAGE.into());
        }
        *slot = Some(args.next().filter(|value| !value.is_empty()).ok_or(USAGE)?);
    }
    let (Some(config), Some(alias), Some(key)) = (config, alias, key) else {
        return Err(USAGE.into());
    };
    let config = PathBuf::from(config);
    let key = EcdsaP256Public::from_authorized_key(&key)?;
    let from = HostId(Uuid::nil());
    let mut host = handover_host(
        &HandoverInput {
            host_id: from,
            name: alias.clone(),
            os: "linux".into(),
            lan: Some(alias.clone()),
            tailscale: None,
        },
        Some(&config),
    )
    .map_err(|reason| io::Error::other(format!("cannot hand over {alias}: {reason:?}")))?;

    let (agent, status) = probe(&config, &alias).await?;
    host.host_id = status
        .host_id
        .ok_or_else(|| io::Error::other("the agent has no host identity"))?;
    let tag = DeviceTag::from_key(&key);
    let key = key.to_base64();
    let name = "iPhone";
    let log = IntentLog::open(config.with_file_name("device-intents.jsonl"))?;
    let issued_ms = wall_ms();
    let seq = log.record(
        host.host_id,
        tag,
        IntentOp::Install {
            key: key.clone(),
            name: name.into(),
        },
        issued_ms,
    )?;
    let layout = match status.layout.as_str() {
        "system" => "--system".into(),
        _ => format!("--socket {}", shell_quote(&status.socket)),
    };
    let command = format!(
        "{agent} authorize-key --key {} --name {} {layout}",
        shell_quote(&key),
        shell_quote(name)
    );
    let result = ssh(&config, &alias, &command).await;
    match result {
        Ok(output) if String::from_utf8_lossy(&output).trim() == tag.to_string() => {
            log.mark_applied(seq, wall_ms())?;
        }
        result => {
            let error = result.err().unwrap_or_else(|| {
                io::Error::other("authorize-key returned an unexpected device tag")
            });
            log.mark_failed(seq, &error.to_string(), wall_ms())?;
            return Err(error.into());
        }
    }
    let bundle = HostBundle {
        version: 1,
        from,
        hosts: vec![host],
        unavailable: Vec::new(),
        issued_ms,
    };
    println!("{}", encode_bundle(&bundle));
    Ok(())
}

async fn probe(config: &Path, alias: &str) -> io::Result<(&'static str, AgentStatus)> {
    let mut stopped = None;
    let mut failures = Vec::new();
    for (agent, flags) in [
        ("\"$HOME\"/.local/bin/statglass-agent", ""),
        ("/usr/local/bin/statglass-agent", " --system"),
    ] {
        let command = format!("exec {agent} status --json{flags}");
        let status = ssh(config, alias, &command).await.and_then(|bytes| {
            serde_json::from_slice::<AgentStatus>(&bytes).map_err(io::Error::other)
        });
        match status {
            Ok(status) if status.host_id.is_some() && status.running => return Ok((agent, status)),
            Ok(status) if status.host_id.is_some() => stopped = Some((agent, status)),
            Ok(_) => failures.push(format!("{agent} has no host identity")),
            Err(error) => failures.push(format!("{agent}: {error}")),
        }
    }
    stopped.ok_or_else(|| io::Error::other(failures.join("; ")))
}

async fn ssh(config: &Path, alias: &str, command: &str) -> io::Result<Vec<u8>> {
    let mut ssh = Command::new("/usr/bin/ssh");
    ssh.arg("-F")
        .arg(config)
        .args([
            "-T",
            "-oBatchMode=yes",
            "-oStrictHostKeyChecking=yes",
            "-oConnectTimeout=10",
            "-oControlPath=none",
            "-oClearAllForwardings=yes",
            "--",
            alias,
            command,
        ])
        .stdin(Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(20), ssh.output())
        .await
        .map_err(|_| {
            io::Error::new(io::ErrorKind::TimedOut, format!("SSH to {alias} timed out"))
        })??;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(io::Error::other(format!(
            "SSH to {alias} ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }
}
