//! The agent as a paired phone's forced command (`restricted --device <tag>`, RFC
//! `plan/rfc-ios-app.md` 2.3): the helper's token table over the agent's socket, with
//! `--system` or `--socket` baked into the `authorized_keys` line.
use anyhow::Context;
use statglass_remote::{
    AGENT_NOT_RUNNING, DeviceTag, SessionScope, SocketPaths, scope::RestrictedCommand,
};
use tokio::net::UnixStream;

/// Runs the forced command for `device` against `paths`; returns the exit code.
pub fn run(device: &str, paths: &SocketPaths) -> anyhow::Result<i32> {
    let Some(device) = DeviceTag::parse(device) else {
        eprintln!("statglass-agent: invalid device tag");
        return Ok(2);
    };
    let original = std::env::var_os("SSH_ORIGINAL_COMMAND");
    let Some(command) = RestrictedCommand::parse(original.as_deref()) else {
        eprintln!("statglass-agent: command not allowed");
        return Ok(2);
    };
    if matches!(command, RestrictedCommand::Version) {
        println!("{}", crate::commands::version());
        return Ok(0);
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("starting the restricted command runtime")?;
    let result = runtime.block_on(run_socket(command, paths, device));
    // The stdio reader can still be blocked when the daemon closes the bridge.
    runtime.shutdown_background();
    result
}

async fn run_socket(
    command: RestrictedCommand,
    paths: &SocketPaths,
    device: DeviceTag,
) -> anyhow::Result<i32> {
    let socket = &paths.metrics;
    let result = UnixStream::connect(socket).await;
    if matches!(command, RestrictedCommand::Status) {
        println!("{}", serde_json::json!({"running": result.is_ok()}));
        return Ok(0);
    }
    match result {
        Ok(stream) => {
            SessionScope::Restricted { device }
                .bridge_stdio(stream)
                .await
                .with_context(|| format!("bridging {}", socket.display()))?;
            Ok(0)
        }
        Err(error) if crate::daemon::not_running(&error) => {
            eprintln!("{AGENT_NOT_RUNNING}");
            Ok(3)
        }
        Err(error) => Err(error).with_context(|| format!("connecting to {}", socket.display())),
    }
}
