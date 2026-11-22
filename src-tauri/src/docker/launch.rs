//! Opens an installed Docker runtime app on the user's request. Only allowlisted bundle
//! ids of runtimes found on this Mac are ever opened; nothing else crosses IPC.
use crate::{AppState, error::CommandError};
use statglass_schema::docker::{DockerRuntimeApp, DockerRuntimeKind, DockerSnapshot};
use tauri::State;

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
    let _ = (kind, installed);
    Err(CommandError::Docker {
        message: "not implemented".into(),
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
    launch_target(kind, &[])?;
    Ok(state.docker.snapshot())
}

#[cfg(test)]
mod tests;
