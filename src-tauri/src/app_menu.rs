//! Native macOS application menu bar (`Help -> File Feedback / Star on GitHub`) and
//! shared menu-event routing for both the app menu and the tray right-click menu.

#[cfg(target_os = "macos")]
use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
use tauri::menu::{MenuEvent, MenuItem};
use tauri::{AppHandle, Wry};
use tauri_plugin_opener::OpenerExt;

use crate::star_prompt::{GITHUB_ISSUES_URL, GITHUB_REPO_URL, StarPromptAction};

/// Menu item id for "File Feedback on GitHub…" in the macOS Help menu.
pub const FEEDBACK_MENU_ID: &str = "menu:feedback";
/// Menu item id for "Send Feedback…" in the tray right-click menu.
pub const TRAY_FEEDBACK_MENU_ID: &str = "tray:feedback";
/// Menu item id for "Star StatGlass on GitHub…" in the macOS Help menu.
pub const STAR_MENU_ID: &str = "menu:star";
/// Menu item id for "Settings…" in the macOS application menu.
pub const SETTINGS_MENU_ID: &str = "menu:settings";
/// Menu item id for "Quit StatGlass" in both the macOS application menu and the tray.
pub const QUIT_MENU_ID: &str = "quit";

/// Semantic action routed from a native application or tray menu item.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuAction {
    /// Open the dashboard window on `/dashboard/settings`.
    OpenSettings,
    /// Open GitHub Issues in the user's default browser.
    OpenFeedback,
    /// Open the GitHub repository and record permanent star opt-out.
    StarOnGitHub,
    /// Exit the app.
    Quit,
}

/// Maps a native menu item id to a [`MenuAction`], returning `None` for unrelated ids.
pub fn classify_menu_event(id: &str) -> Option<MenuAction> {
    match id {
        FEEDBACK_MENU_ID | TRAY_FEEDBACK_MENU_ID => Some(MenuAction::OpenFeedback),
        STAR_MENU_ID => Some(MenuAction::StarOnGitHub),
        SETTINGS_MENU_ID => Some(MenuAction::OpenSettings),
        QUIT_MENU_ID => Some(MenuAction::Quit),
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

/// "Quit StatGlass" (Cmd+Q), shared by the macOS app menu and the tray right-click menu.
pub fn quit_item(app: &AppHandle) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(
        app,
        QUIT_MENU_ID,
        "Quit StatGlass",
        true,
        Some("CmdOrCtrl+Q"),
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
            // An explicit exit, so `RunEvent::ExitRequested { code: None }` does not block Quit.
            // `RunEvent::ExitRequested { code: None }` does not block an explicit Quit.
            &quit_item(app)?,
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

/// Registers the app's one menu listener and, on macOS, installs the application menu bar
/// (shown when "Show in Dock" switches to the Regular activation policy).
#[cfg(target_os = "macos")]
pub fn install(app: &AppHandle) -> anyhow::Result<()> {
    // Once for the app: Tauri delivers every menu's events (app menu and each tray item's
    // menu) to every listener, so a second listener would fire each action twice.
    app.on_menu_event(on_menu_event);
    let app_menu = app_submenu(app)?;
    let edit_menu = edit_submenu(app)?;
    let window_menu = window_submenu(app)?;
    let help_menu = help_submenu(app)?;
    let menu = Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu, &help_menu])?;
    app.set_menu(menu)?;
    Ok(())
}

/// Registers the app's one menu listener. There is no application menu bar off macOS.
#[cfg(not(target_os = "macos"))]
pub fn install(app: &AppHandle) -> anyhow::Result<()> {
    app.on_menu_event(on_menu_event);
    Ok(())
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    tracing::debug!(item = id, "menu");
    if !handle_menu_event(app, id) {
        crate::tray::on_menu_item(app, id);
    }
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
            // Saving blocks on a file write; menu events arrive on the main thread.
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(err) =
                    crate::star_prompt::act_and_notify(&app, StarPromptAction::Starred)
                {
                    tracing::warn!("recording github star action: {err}");
                }
            });
        }
        // An exit code, unlike closing the last window, ends the app (lib.rs `run`), and
        // `RunEvent::Exit` stops the engine and closes the store.
        MenuAction::Quit => app.exit(0),
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
        assert_eq!(classify_menu_event(QUIT_MENU_ID), Some(MenuAction::Quit));
        assert_eq!(classify_menu_event(""), None);
    }
}
