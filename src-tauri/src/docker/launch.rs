//! Opens an installed Docker runtime app on the user's request. Only allowlisted bundle
//! ids of runtimes found on this Mac are ever opened; nothing else crosses IPC.
use crate::{AppState, error::CommandError};
use statglass_engine::docker::{runtime_bundle_id, runtime_display_name};
use statglass_schema::docker::{DockerRuntimeApp, DockerRuntimeKind, DockerSnapshot};
use std::time::Duration;
use tauri::State;

/// LaunchServices' command-line entry point; `-b` opens an app by bundle id.
const OPEN: &str = "/usr/bin/open";
/// How long `open` may take before the launch counts as failed.
const OPEN_TIMEOUT: Duration = Duration::from_secs(10);

/// The bundle id to open for `kind`, if it is installed and is an app.
///
/// # Errors
/// `CommandError::Docker` when the runtime isn't installed ("Docker Desktop isn’t
/// installed on this Mac.") or has no app ("Colima has no app to open. Run `colima
/// start` in Terminal.").
pub(crate) fn launch_target(
    kind: DockerRuntimeKind,
    installed: &[DockerRuntimeApp],
) -> Result<&'static str, CommandError> {
    if !installed.iter().any(|runtime| runtime.kind == kind) {
        return Err(docker_error(format!(
            "{} isn’t installed on this Mac.",
            runtime_display_name(kind)
        )));
    }
    runtime_bundle_id(kind).ok_or_else(|| {
        docker_error(format!(
            "{} has no app to open. Run `colima start` in Terminal.",
            runtime_display_name(kind)
        ))
    })
}

/// Opens the runtime app through LaunchServices, then starts the engine's post-launch
/// retry window and returns the current snapshot.
///
/// # Errors
/// `CommandError::Docker` from [`launch_target`], or when `open` fails (its stderr is
/// included).
#[tauri::command]
#[specta::specta]
pub async fn docker_launch_runtime(
    state: State<'_, AppState>,
    kind: DockerRuntimeKind,
) -> Result<DockerSnapshot, CommandError> {
    let bundle = launch_target(kind, &state.docker.installed_runtimes())?;
    open_bundle(bundle).await.map_err(|reason| {
        docker_error(format!(
            "Couldn’t open {}: {reason}",
            runtime_display_name(kind)
        ))
    })?;
    state.docker.launch_started();
    Ok(state.docker.snapshot())
}

/// Runs `open -b <bundle>` and waits for it to exit.
///
/// # Errors
/// Why the launch failed: the spawn error, the timeout, or `open`'s trimmed stderr
/// (its exit status when stderr is empty).
async fn open_bundle(bundle: &str) -> Result<(), String> {
    let run = tokio::process::Command::new(OPEN)
        .args(["-b", bundle])
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(OPEN_TIMEOUT, run)
        .await
        .map_err(|_| format!("open didn’t finish within {} s", OPEN_TIMEOUT.as_secs()))?
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if stderr.is_empty() {
        return Err(format!("open exited with {}", output.status));
    }
    Err(stderr)
}

/// A `CommandError::Docker` carrying user-facing `message`.
fn docker_error(message: String) -> CommandError {
    CommandError::Docker { message }
}

#[cfg(test)]
mod tests;
