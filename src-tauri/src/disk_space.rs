//! Disk space report commands (plan/disk-space-report.md). This Mac's scans run on
//! `AppState::disk_space`; a remote host's run on that host and are asked for over its
//! session (D-117). The service lives in `statglass-engine`; this module adapts it to
//! commands and Reveal in Finder, which is this Mac only.
use statglass_engine::disk_space::SpaceError;
use statglass_remote::RemoteError;
use statglass_schema::HostId;
use statglass_schema::disk_space::{
    SpaceFile, SpaceHighlights, SpaceReport, SpaceScanStatus, SpaceSubtree, SpaceTarget,
    SpaceVolume,
};
use tauri::State;

use crate::commands::spawn_blocking;
use crate::error::CommandError;
use crate::state::{AppState, Route};

impl From<SpaceError> for CommandError {
    fn from(e: SpaceError) -> Self {
        Self::DiskSpace {
            message: e.to_string(),
        }
    }
}

/// Whether this build can scan (false in the sandboxed App Store edition).
pub const fn available() -> bool {
    cfg!(not(feature = "appstore"))
}

fn guard() -> Result<(), CommandError> {
    if available() {
        Ok(())
    } else {
        Err(CommandError::DiskSpace {
            message: "Space reports are not available in this edition".into(),
        })
    }
}

/// A remote host's refusal is the same `disk_space` error a local scan gives.
fn remote_error(error: RemoteError) -> CommandError {
    match error {
        RemoteError::Refused(message) => CommandError::DiskSpace { message },
        other => other.into(),
    }
}

/// The dashboard closed: drops this Mac's report and asks each remote host to drop the
/// scan this Mac started there.
pub fn dashboard_closed(state: &AppState) {
    state.disk_space.clear();
    for source in state.remotes.sources() {
        tauri::async_runtime::spawn(async move {
            let _ = source.space_clear().await;
        });
    }
}

#[tauri::command]
#[specta::specta]
pub async fn disk_space_volumes(
    state: State<'_, AppState>,
    host: HostId,
) -> Result<Vec<SpaceVolume>, CommandError> {
    guard()?;
    if let Route::Remote(source) = state.route(host)? {
        return source.space_volumes().await.map_err(remote_error);
    }
    let service = state.disk_space.clone();
    spawn_blocking(move || service.volumes()).await
}

#[tauri::command]
#[specta::specta]
pub async fn disk_space_start(
    state: State<'_, AppState>,
    host: HostId,
    volume: String,
    include: Vec<String>,
) -> Result<SpaceScanStatus, CommandError> {
    guard()?;
    if let Route::Remote(source) = state.route(host)? {
        // A remote scan never enters protected locations (D-117).
        return source.space_start(volume).await.map_err(remote_error);
    }
    let service = state.disk_space.clone();
    spawn_blocking(move || service.start(&volume, &include))
        .await?
        .map_err(CommandError::from)
}

#[tauri::command]
#[specta::specta]
pub async fn disk_space_status(
    state: State<'_, AppState>,
    host: HostId,
) -> Result<SpaceScanStatus, CommandError> {
    if let Route::Remote(source) = state.route(host)? {
        return source.space_status().await.map_err(remote_error);
    }
    Ok(state.disk_space.status())
}

#[tauri::command]
#[specta::specta]
pub async fn disk_space_cancel(
    state: State<'_, AppState>,
    host: HostId,
) -> Result<(), CommandError> {
    if let Route::Remote(source) = state.route(host)? {
        return source.space_cancel().await.map_err(remote_error);
    }
    state.disk_space.cancel();
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn disk_space_report(
    state: State<'_, AppState>,
    host: HostId,
) -> Result<Option<SpaceReport>, CommandError> {
    if let Route::Remote(source) = state.route(host)? {
        return source.space_report().await.map_err(remote_error);
    }
    Ok(state.disk_space.report())
}

#[tauri::command]
#[specta::specta]
pub async fn disk_space_subtree(
    state: State<'_, AppState>,
    host: HostId,
    report: u32,
    node: Option<u32>,
) -> Result<SpaceSubtree, CommandError> {
    if let Route::Remote(source) = state.route(host)? {
        return source
            .space_subtree(report, node)
            .await
            .map_err(remote_error);
    }
    Ok(state.disk_space.subtree(report, node)?)
}

#[tauri::command]
#[specta::specta]
pub async fn disk_space_largest_files(
    state: State<'_, AppState>,
    host: HostId,
    report: u32,
) -> Result<Vec<SpaceFile>, CommandError> {
    if let Route::Remote(source) = state.route(host)? {
        return source
            .space_largest_files(report)
            .await
            .map_err(remote_error);
    }
    Ok(state.disk_space.largest_files(report)?)
}

/// The path of an entry of a report, as the host shows it, for Copy path.
#[tauri::command]
#[specta::specta]
pub async fn disk_space_path(
    state: State<'_, AppState>,
    host: HostId,
    report: u32,
    target: SpaceTarget,
) -> Result<String, CommandError> {
    if let Route::Remote(source) = state.route(host)? {
        return source
            .space_path(report, target)
            .await
            .map_err(remote_error);
    }
    let path = state.disk_space.reveal_path(report, target)?;
    Ok(path.to_string_lossy().into_owned())
}

/// The largest actionable folders of this Mac's last boot-volume scan, kept between
/// launches for the Overview. A remote host has none: the summary stays off the wire.
/// Off the main thread: reading it can settle a finished scan, which ranks and writes.
#[tauri::command]
#[specta::specta]
pub async fn disk_space_highlights(
    state: State<'_, AppState>,
    host: HostId,
) -> Result<Option<SpaceHighlights>, CommandError> {
    if !available() || matches!(state.route(host)?, Route::Remote(_)) {
        return Ok(None);
    }
    let service = state.disk_space.clone();
    spawn_blocking(move || service.highlights()).await
}

/// Shows an entry of this Mac's report in Finder. Paths come from the report, never the
/// webview.
#[tauri::command]
#[specta::specta]
pub fn disk_space_reveal(
    state: State<'_, AppState>,
    report: u32,
    target: SpaceTarget,
) -> Result<(), CommandError> {
    reveal(&state.disk_space.reveal_path(report, target)?)
}

/// Shows a folder of the highlights summary in Finder. Only a path the summary holds is
/// revealed, so the webview cannot name an arbitrary one.
#[tauri::command]
#[specta::specta]
pub async fn disk_space_reveal_highlight(
    state: State<'_, AppState>,
    path: String,
) -> Result<(), CommandError> {
    guard()?;
    let service = state.disk_space.clone();
    spawn_blocking(move || {
        if !service.is_highlight(&path) {
            return Err(CommandError::DiskSpace {
                message: "This folder is not in the last scan".into(),
            });
        }
        reveal(std::path::Path::new(&path))
    })
    .await?
}

fn reveal(path: &std::path::Path) -> Result<(), CommandError> {
    if !path.exists() {
        return Err(CommandError::DiskSpace {
            message: "This item no longer exists".into(),
        });
    }
    std::process::Command::new("/usr/bin/open")
        .arg("-R")
        .arg(path)
        .status()
        .map_err(|e| CommandError::DiskSpace {
            message: format!("Couldn't open Finder: {e}"),
        })
        .and_then(|status| {
            status
                .success()
                .then_some(())
                .ok_or(CommandError::DiskSpace {
                    message: "Finder couldn't show this item".into(),
                })
        })
}
