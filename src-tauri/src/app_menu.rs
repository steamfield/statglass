//! Native macOS application menu bar (`Help -> File Feedback / Star on GitHub`) and
//! shared menu-event routing for both the app menu and the tray right-click menu.

use tauri::AppHandle;

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
    let _ = id;
    todo!("not implemented")
}

/// Installs the native macOS application menu bar (active when "Show in Dock" / Regular
/// activation policy is enabled). No-op on non-macOS targets.
pub fn install(app: &AppHandle) -> anyhow::Result<()> {
    let _ = app;
    todo!("not implemented")
}

/// Handles an application or tray menu event id if it maps to a [`MenuAction`].
/// Returns `true` when handled.
pub fn handle_menu_event(app: &AppHandle, id: &str) -> bool {
    let _ = (app, id);
    todo!("not implemented")
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
