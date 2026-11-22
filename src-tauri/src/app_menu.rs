//! Native macOS application menu bar (`Help -> File Feedback / Star on GitHub`) and
//! shared menu-event routing for both the app menu and the tray right-click menu.

use tauri::menu::MenuItem;
#[cfg(target_os = "macos")]
use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_opener::OpenerExt;

use crate::star_prompt::{GITHUB_ISSUES_URL, GITHUB_REPO_URL, StarPromptAction};
use crate::state::AppState;

/// Menu item id for "File Feedback on GitHub…" in the macOS Help menu.
pub const FEEDBACK_MENU_ID: &str = "menu:feedback";
/// Menu item id for "Send Feedback…" in the tray right-click menu.
pub const TRAY_FEEDBACK_MENU_ID: &str = "tray:feedback";
/// Menu item id for "Star StatGlass on GitHub…" in the macOS Help menu.
pub const STAR_MENU_ID: &str = "menu:star";
/// Menu item id for "Settings…" in the macOS application menu.
pub const SETTINGS_MENU_ID: &str = "menu:settings";

/// Semantic action routed from a native application or tray menu item.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuAction {
    /// Open the dashboard window on `/dashboard/settings`.
    OpenSettings,
    /// Open GitHub Issues in the user's default browser.
    OpenFeedback,
    /// Open the GitHub repository and record permanent star opt-out.
    StarOnGitHub,
}

/// Maps a native menu item id to a [`MenuAction`], returning `None` for unrelated ids.
pub fn classify_menu_event(id: &str) -> Option<MenuAction> {
    match id {
        FEEDBACK_MENU_ID | TRAY_FEEDBACK_MENU_ID => Some(MenuAction::OpenFeedback),
        STAR_MENU_ID => Some(MenuAction::StarOnGitHub),
        SETTINGS_MENU_ID => Some(MenuAction::OpenSettings),
        _ => None,
    }
}

/// "Settings…" (Cmd+,), shared by the macOS app menu and the tray right-click menu.
pub fn settings_item(app: &AppHandle) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(
        app,
        SETTINGS_MENU_ID,
        "Settings…",
        true,
        Some("CmdOrCtrl+,"),
    )
}

/// "Send Feedback…" in the tray right-click menu.
pub fn tray_feedback_item(app: &AppHandle) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(
        app,
        TRAY_FEEDBACK_MENU_ID,
        "Send Feedback…",
        true,
        None::<&str>,
    )
}

#[cfg(target_os = "macos")]
fn app_submenu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    Submenu::with_items(
        app,
        "StatGlass",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &settings_item(app)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            // Routed through `tray::on_menu_event` (`"quit" => app.exit(0)`) so
            // `RunEvent::ExitRequested { code: None }` does not block an explicit Quit.
            &MenuItem::with_id(app, "quit", "Quit StatGlass", true, Some("CmdOrCtrl+Q"))?,
        ],
    )
}

#[cfg(target_os = "macos")]
fn edit_submenu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )
}

#[cfg(target_os = "macos")]
fn window_submenu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::close_window(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::maximize(app, None)?,
        ],
    )
}

#[cfg(target_os = "macos")]
fn help_submenu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &MenuItem::with_id(
                app,
                FEEDBACK_MENU_ID,
                "File Feedback on GitHub…",
                true,
                None::<&str>,
            )?,
            &MenuItem::with_id(
                app,
                STAR_MENU_ID,
                "Star StatGlass on GitHub…",
                true,
                None::<&str>,
            )?,
        ],
    )
}

/// Installs the native macOS application menu bar (active when "Show in Dock" / Regular
/// activation policy is enabled). No-op on non-macOS targets.
#[cfg(target_os = "macos")]
pub fn install(app: &AppHandle) -> anyhow::Result<()> {
    let app_menu = app_submenu(app)?;
    let edit_menu = edit_submenu(app)?;
    let window_menu = window_submenu(app)?;
    let help_menu = help_submenu(app)?;
    let menu = Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu, &help_menu])?;
    app.set_menu(menu)?;
    Ok(())
}

/// Installs the native macOS application menu bar (active when "Show in Dock" / Regular
/// activation policy is enabled). No-op on non-macOS targets.
#[cfg(not(target_os = "macos"))]
pub fn install(_app: &AppHandle) -> anyhow::Result<()> {
    Ok(())
}

/// Handles an application or tray menu event id if it maps to a [`MenuAction`].
/// Returns `true` when handled.
pub fn handle_menu_event(app: &AppHandle, id: &str) -> bool {
    let Some(action) = classify_menu_event(id) else {
        return false;
    };
    match action {
        MenuAction::OpenSettings => {
            if let Err(err) = crate::windows::open_dashboard(app, Some("/dashboard/settings")) {
                tracing::warn!("opening settings from the app menu: {err}");
            }
        }
        MenuAction::OpenFeedback => {
            if let Err(err) = app.opener().open_url(GITHUB_ISSUES_URL, None::<&str>) {
                tracing::warn!("opening feedback url: {err}");
            }
        }
        MenuAction::StarOnGitHub => {
            if let Err(err) = app.opener().open_url(GITHUB_REPO_URL, None::<&str>) {
                tracing::warn!("opening github repo url: {err}");
            }
            if let Some(state) = app.try_state::<AppState>()
                && let Err(err) = state
                    .star_prompt
                    .act(StarPromptAction::Starred, statglass_engine::wall_ms())
            {
                tracing::warn!("recording github star action: {err}");
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_app_and_tray_feedback_star_and_settings_ids() {
        assert_eq!(
            classify_menu_event(FEEDBACK_MENU_ID),
            Some(MenuAction::OpenFeedback)
        );
        assert_eq!(
            classify_menu_event(TRAY_FEEDBACK_MENU_ID),
            Some(MenuAction::OpenFeedback)
        );
        assert_eq!(
            classify_menu_event(STAR_MENU_ID),
            Some(MenuAction::StarOnGitHub)
        );
        assert_eq!(
            classify_menu_event(SETTINGS_MENU_ID),
            Some(MenuAction::OpenSettings)
        );
        assert_eq!(classify_menu_event("open"), None);
        assert_eq!(classify_menu_event("pause"), None);
        assert_eq!(classify_menu_event("quit"), None);
        assert_eq!(classify_menu_event(""), None);
    }
}
