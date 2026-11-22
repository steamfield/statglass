//! GitHub star prompt state machine, persistence, and Tauri commands.
//!
//! Rust owns eligibility so all surfaces agree on when the user has used StatGlass for
//! more than 24 hours, shown real engagement, and neither starred, permanently dismissed,
//! nor snoozed the prompt.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use statglass_schema::lock::LockExt;
use tauri::{AppHandle, Manager, State};
use tauri_specta::Event;

use crate::error::CommandError;
use crate::state::AppState;

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Repository page opened when the user chooses to star StatGlass on GitHub.
pub const GITHUB_REPO_URL: &str = "https://github.com/steamfield/statglass";
/// Issues page opened from Feedback entry points.
pub const GITHUB_ISSUES_URL: &str = "https://github.com/steamfield/statglass/issues";
/// Minimum elapsed wall-clock time since first use before prompting (strictly > 24 hours).
pub const MIN_ELAPSED_MS: i64 = 24 * 60 * 60 * 1000;
/// Duration of a single "Not now" snooze (7 days).
pub const SNOOZE_DURATION_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// Minimum spacing between counted user interactions so rapid toggles do not double-count.
pub const ENGAGEMENT_COOLDOWN_MS: i64 = 5 * 60 * 1000;
/// Distinct engaged sessions (dashboard or popover opens) required before prompting.
pub const REQUIRED_ENGAGEMENT_SESSIONS: u32 = 3;
/// File name under `<app_data_dir>` storing persisted prompt state.
pub const STAR_PROMPT_FILE: &str = "star-prompt.json";

/// Current star-prompt eligibility published to the dashboard window.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, specta::Type)]
pub struct StarPromptStatus {
    /// True when >24h have elapsed, engagement threshold is met, and the prompt is neither
    /// permanently closed nor currently snoozed.
    pub eligible: bool,
    /// True when the user can still snooze once ("Not now"); false on the final appearance.
    pub can_snooze: bool,
}

/// User action taken on the GitHub star prompt.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum StarPromptAction {
    /// Clicked "Star on GitHub" -> permanent opt-out.
    Starred,
    /// Clicked dismiss (`×` or "Don't ask again") -> permanent opt-out.
    Dismissed,
    /// Clicked "Not now" -> snoozes for 7 days once; a second snooze permanently dismisses.
    Snoozed,
}

/// Persisted star-prompt state serialized to `star-prompt.json`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StarPromptState {
    /// Epoch milliseconds when StatGlass was first seen on this machine.
    pub first_seen_at_ms: i64,
    /// Number of distinct debounced user interactions recorded so far.
    #[serde(default)]
    pub engagement_sessions: u32,
    /// Epoch milliseconds of the last counted user interaction.
    #[serde(default)]
    pub last_interaction_at_ms: Option<i64>,
    /// Number of times the user has snoozed the prompt.
    #[serde(default)]
    pub snooze_count: u32,
    /// Epoch milliseconds until which a snoozed prompt stays hidden.
    #[serde(default)]
    pub snoozed_until_ms: Option<i64>,
    /// Epoch milliseconds when the user permanently dismissed the prompt.
    #[serde(default)]
    pub dismissed_at_ms: Option<i64>,
    /// Epoch milliseconds when the user chose to star StatGlass on GitHub.
    #[serde(default)]
    pub starred_at_ms: Option<i64>,
}

/// Persistence boundary for `StarPromptOwner` so state transitions are unit-tested without disk I/O.
pub trait StarPromptStore: Send + Sync {
    /// Loads persisted bytes, returning `Ok(None)` when the file does not exist yet.
    fn load(&self) -> std::io::Result<Option<String>>;
    /// Atomically saves serialized JSON with owner-only permissions.
    fn save(&self, content: &str) -> Result<(), String>;
}

/// Production file-backed store under `<app_data_dir>/star-prompt.json`.
pub struct FileStarPromptStore {
    path: PathBuf,
}

impl FileStarPromptStore {
    /// Creates a file store rooted at `dir.join(STAR_PROMPT_FILE)`.
    pub fn in_dir(dir: &Path) -> Self {
        Self {
            path: dir.join(STAR_PROMPT_FILE),
        }
    }
}

impl StarPromptStore for FileStarPromptStore {
    fn load(&self) -> std::io::Result<Option<String>> {
        match std::fs::read_to_string(&self.path) {
            Ok(raw) => Ok(Some(raw)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err),
        }
    }

    fn save(&self, content: &str) -> Result<(), String> {
        if let Some(parent) = self.path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("creating {}: {e}", parent.display()))?;
        }
        let tmp_path = temp_path_for(&self.path);
        let write_and_swap = write_temp_file(&tmp_path, content).and_then(|()| {
            std::fs::rename(&tmp_path, &self.path).map_err(|e| {
                format!(
                    "renaming {} to {}: {e}",
                    tmp_path.display(),
                    self.path.display()
                )
            })
        });
        if let Err(err) = write_and_swap {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(err);
        }
        if let Err(err) = statglass_store::restrict(&self.path) {
            tracing::warn!("restricting {}: {err}", self.path.display());
        }
        Ok(())
    }
}

fn temp_path_for(target: &Path) -> PathBuf {
    let dir = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let seq = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    dir.join(format!(
        ".{STAR_PROMPT_FILE}.tmp.{}.{seq}",
        std::process::id()
    ))
}

fn write_temp_file(tmp_path: &Path, content: &str) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(tmp_path)
        .map_err(|e| format!("creating {}: {e}", tmp_path.display()))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("writing {}: {e}", tmp_path.display()))?;
    file.sync_all()
        .map_err(|e| format!("syncing {}: {e}", tmp_path.display()))?;
    drop(file);
    // Restrict before rename so the target path never observes broader permissions.
    statglass_store::restrict(tmp_path)
        .map_err(|e| format!("restricting {}: {e}", tmp_path.display()))?;
    Ok(())
}

fn seeded_first_seen_ms(history_created_at_ms: Option<i64>, now_ms: i64) -> i64 {
    history_created_at_ms.map_or(now_ms, |created| created.min(now_ms))
}

fn fresh_state(first_seen_at_ms: i64) -> StarPromptState {
    StarPromptState {
        first_seen_at_ms,
        engagement_sessions: 0,
        last_interaction_at_ms: None,
        snooze_count: 0,
        snoozed_until_ms: None,
        dismissed_at_ms: None,
        starred_at_ms: None,
    }
}

fn status_at(state: &StarPromptState, now_ms: i64) -> StarPromptStatus {
    let eligible = state.starred_at_ms.is_none()
        && state.dismissed_at_ms.is_none()
        && now_ms.saturating_sub(state.first_seen_at_ms) > MIN_ELAPSED_MS
        && state.engagement_sessions >= REQUIRED_ENGAGEMENT_SESSIONS
        && state.snoozed_until_ms.is_none_or(|until| now_ms > until);
    StarPromptStatus {
        eligible,
        can_snooze: state.snooze_count == 0,
    }
}

fn next_after_interaction(state: &StarPromptState, now_ms: i64) -> Option<StarPromptState> {
    if state.starred_at_ms.is_some()
        || state.dismissed_at_ms.is_some()
        || state.engagement_sessions >= REQUIRED_ENGAGEMENT_SESSIONS
    {
        return None;
    }
    if state
        .last_interaction_at_ms
        .is_some_and(|last| now_ms < last || now_ms.saturating_sub(last) < ENGAGEMENT_COOLDOWN_MS)
    {
        return None;
    }
    let mut next = state.clone();
    next.engagement_sessions = next.engagement_sessions.saturating_add(1);
    next.last_interaction_at_ms = Some(now_ms);
    Some(next)
}

fn apply_action(state: &StarPromptState, action: StarPromptAction, now_ms: i64) -> StarPromptState {
    let mut next = state.clone();
    match action {
        StarPromptAction::Starred => {
            next.starred_at_ms = Some(now_ms);
            next.snoozed_until_ms = None;
        }
        StarPromptAction::Dismissed => {
            next.dismissed_at_ms = Some(now_ms);
            next.snoozed_until_ms = None;
        }
        StarPromptAction::Snoozed if next.snooze_count == 0 => {
            next.snooze_count = 1;
            next.snoozed_until_ms = Some(now_ms.saturating_add(SNOOZE_DURATION_MS));
        }
        StarPromptAction::Snoozed => {
            next.dismissed_at_ms = Some(now_ms);
            next.snoozed_until_ms = None;
        }
    }
    next
}

fn serialize_state(state: &StarPromptState) -> Result<String, String> {
    serde_json::to_string_pretty(state).map_err(|e| format!("serializing {STAR_PROMPT_FILE}: {e}"))
}

fn persist_best_effort(store: &dyn StarPromptStore, state: &StarPromptState) {
    let encoded = match serialize_state(state) {
        Ok(encoded) => encoded,
        Err(err) => {
            tracing::warn!("{err}");
            return;
        }
    };
    if let Err(err) = store.save(&encoded) {
        tracing::warn!("saving {STAR_PROMPT_FILE}: {err}");
    }
}

fn load_initial_state(
    store: &dyn StarPromptStore,
    history_created_at_ms: Option<i64>,
    now_ms: i64,
) -> StarPromptState {
    let seeded_first_seen = seeded_first_seen_ms(history_created_at_ms, now_ms);
    match store.load() {
        Ok(Some(raw)) => match serde_json::from_str::<StarPromptState>(&raw) {
            Ok(state) => state,
            Err(err) => {
                tracing::warn!("stored {STAR_PROMPT_FILE} failed to parse ({err}); resetting");
                fresh_state(seeded_first_seen)
            }
        },
        Ok(None) => {
            let state = fresh_state(seeded_first_seen);
            persist_best_effort(store, &state);
            state
        }
        Err(err) => {
            tracing::warn!("reading {STAR_PROMPT_FILE} failed ({err}); starting fresh");
            fresh_state(seeded_first_seen)
        }
    }
}

/// When the history database was created, which seeds an existing user's tenure. A read
/// failure is logged, since the fallback restarts that tenure at first launch.
pub fn history_created_at_ms(history: &crate::history::History) -> Option<i64> {
    history
        .read(|r| r.created_at_ms())
        .inspect_err(|e| tracing::warn!("reading history created_at_ms: {e}"))
        .ok()
        .flatten()
}

/// Thread-safe owner of star-prompt eligibility and engagement tracking.
pub struct StarPromptOwner {
    store: Box<dyn StarPromptStore>,
    state: Mutex<StarPromptState>,
}

impl StarPromptOwner {
    /// Opens or initializes `star-prompt.json` in `dir`, seeding `first_seen_at_ms` from
    /// `history_created_at_ms` when available so existing users keep their tenure.
    pub fn open(dir: &Path, history_created_at_ms: Option<i64>, now_ms: i64) -> Self {
        Self::with_store(
            Box::new(FileStarPromptStore::in_dir(dir)),
            history_created_at_ms,
            now_ms,
        )
    }

    /// Initializes an owner over a custom [`StarPromptStore`] (used by tests and [`Self::open`]).
    pub fn with_store(
        store: Box<dyn StarPromptStore>,
        history_created_at_ms: Option<i64>,
        now_ms: i64,
    ) -> Self {
        let initial = load_initial_state(store.as_ref(), history_created_at_ms, now_ms);
        Self {
            store,
            state: Mutex::new(initial),
        }
    }

    /// Computes eligibility at `now_ms` without mutating state.
    pub fn status(&self, now_ms: i64) -> StarPromptStatus {
        let state = self.state.lock_ok();
        status_at(&state, now_ms)
    }

    /// Records a user-initiated dashboard or popover open, debounced by
    /// [`ENGAGEMENT_COOLDOWN_MS`] and capped once [`REQUIRED_ENGAGEMENT_SESSIONS`] is reached.
    pub fn record_interaction(&self, now_ms: i64) {
        let mut state = self.state.lock_ok();
        let Some(next) = next_after_interaction(&state, now_ms) else {
            return;
        };
        persist_best_effort(self.store.as_ref(), &next);
        *state = next;
    }

    /// Applies `action` at `now_ms`, persisting before committing in-memory state.
    pub fn act(
        &self,
        action: StarPromptAction,
        now_ms: i64,
    ) -> Result<StarPromptStatus, CommandError> {
        let mut state = self.state.lock_ok();
        let next = apply_action(&state, action, now_ms);
        let encoded =
            serialize_state(&next).map_err(|message| CommandError::SettingsNotSaved { message })?;
        self.store
            .save(&encoded)
            .map_err(|message| CommandError::SettingsNotSaved { message })?;
        *state = next;
        Ok(status_at(&state, now_ms))
    }
}

/// Returns whether the dashboard should show the GitHub star prompt.
#[tauri::command]
#[specta::specta]
pub fn get_star_prompt_status(state: State<'_, AppState>) -> StarPromptStatus {
    state.star_prompt.status(statglass_engine::wall_ms())
}

/// Persists the user's star, dismiss, or snooze choice and returns the updated status.
///
/// # Errors
///
/// [`CommandError::SettingsNotSaved`] when `star-prompt.json` can't be written.
#[tauri::command]
#[specta::specta]
pub async fn act_on_star_prompt(
    app: AppHandle,
    action: StarPromptAction,
) -> Result<StarPromptStatus, CommandError> {
    crate::commands::spawn_blocking(move || act_and_notify(&app, action)).await?
}

/// Sent to every window after a star, dismiss or snooze is saved, so a dashboard showing
/// the prompt hides it when the choice came from Settings or the app menu.
#[derive(Clone, Debug, Serialize, specta::Type, Event)]
pub struct StarPromptChanged {
    pub status: StarPromptStatus,
}

/// Saves `action` now and announces the new status with [`StarPromptChanged`]. Blocks on
/// the file write, so callers run it off the main thread.
///
/// # Errors
///
/// [`CommandError::SettingsNotSaved`] when `star-prompt.json` can't be written.
pub fn act_and_notify(
    app: &AppHandle,
    action: StarPromptAction,
) -> Result<StarPromptStatus, CommandError> {
    let state = app.state::<AppState>();
    let status = state.star_prompt.act(action, statglass_engine::wall_ms())?;
    if let Err(err) = (StarPromptChanged { status }).emit(app) {
        tracing::warn!("sending star prompt change: {err}");
    }
    Ok(status)
}

/// Counts a user-opened dashboard or popover toward engagement. The write runs on a
/// blocking worker so it never delays a window open on the main thread.
pub fn record_engagement(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(state) = app.try_state::<AppState>() {
            state
                .star_prompt
                .record_interaction(statglass_engine::wall_ms());
        }
    });
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    #[derive(Clone, Default)]
    struct MemStore {
        data: Arc<Mutex<Option<String>>>,
        saves: Arc<Mutex<u32>>,
        fail_save: Arc<Mutex<bool>>,
    }

    impl MemStore {
        fn with_raw(raw: &str) -> Self {
            Self {
                data: Arc::new(Mutex::new(Some(raw.to_owned()))),
                saves: Arc::new(Mutex::new(0)),
                fail_save: Arc::new(Mutex::new(false)),
            }
        }

        fn save_count(&self) -> u32 {
            *self.saves.lock().unwrap()
        }

        fn set_fail_save(&self, fail: bool) {
            *self.fail_save.lock().unwrap() = fail;
        }
    }

    impl StarPromptStore for MemStore {
        fn load(&self) -> std::io::Result<Option<String>> {
            Ok(self.data.lock().unwrap().clone())
        }

        fn save(&self, content: &str) -> Result<(), String> {
            if *self.fail_save.lock().unwrap() {
                return Err("disk full".into());
            }
            *self.saves.lock().unwrap() += 1;
            *self.data.lock().unwrap() = Some(content.to_owned());
            Ok(())
        }
    }

    const T0: i64 = 1_700_000_000_000;

    fn engage_three_times(owner: &StarPromptOwner, start_ms: i64) {
        for i in 0..REQUIRED_ENGAGEMENT_SESSIONS as i64 {
            owner.record_interaction(start_ms + i * ENGAGEMENT_COOLDOWN_MS);
        }
    }

    #[test]
    fn fresh_install_requires_strictly_more_than_24h_and_three_sessions() {
        let store = MemStore::default();
        let owner = StarPromptOwner::with_store(Box::new(store), None, T0);

        assert!(!owner.status(T0).eligible);
        assert!(owner.status(T0).can_snooze);

        // Even after 24h+1ms, fewer than 3 sessions stays ineligible.
        owner.record_interaction(T0);
        owner.record_interaction(T0 + ENGAGEMENT_COOLDOWN_MS);
        assert!(!owner.status(T0 + MIN_ELAPSED_MS + 1).eligible);

        // Reaches 3 sessions, but at exact 24h boundary it is still ineligible.
        owner.record_interaction(T0 + 2 * ENGAGEMENT_COOLDOWN_MS);
        assert!(!owner.status(T0 + MIN_ELAPSED_MS).eligible);
        assert_eq!(
            owner.status(T0 + MIN_ELAPSED_MS + 1),
            StarPromptStatus {
                eligible: true,
                can_snooze: true,
            }
        );
    }

    #[test]
    fn existing_user_seeds_from_history_created_at_and_clamps_future_timestamps() {
        let history_created = T0 - MIN_ELAPSED_MS - 60_000;
        let owner =
            StarPromptOwner::with_store(Box::new(MemStore::default()), Some(history_created), T0);
        engage_three_times(&owner, T0);
        assert!(owner.status(T0 + 2 * ENGAGEMENT_COOLDOWN_MS).eligible);

        // A clock-skewed future history timestamp must not push first_seen into the future.
        let future_history = T0 + 10 * MIN_ELAPSED_MS;
        let skewed =
            StarPromptOwner::with_store(Box::new(MemStore::default()), Some(future_history), T0);
        engage_three_times(&skewed, T0);
        assert!(!skewed.status(T0 + MIN_ELAPSED_MS).eligible);
        assert!(skewed.status(T0 + MIN_ELAPSED_MS + 1).eligible);
    }

    #[test]
    fn interaction_cooldown_debounces_and_stops_writing_once_threshold_met() {
        let store = MemStore::default();
        let owner = StarPromptOwner::with_store(Box::new(store.clone()), None, T0);
        let initial_saves = store.save_count();

        owner.record_interaction(T0);
        assert_eq!(store.save_count(), initial_saves + 1);

        // Within cooldown: ignored, no disk write.
        owner.record_interaction(T0 + ENGAGEMENT_COOLDOWN_MS - 1);
        assert_eq!(store.save_count(), initial_saves + 1);

        // Backward wall-clock jump must not double-count or panic.
        owner.record_interaction(T0 - 60_000);
        assert_eq!(store.save_count(), initial_saves + 1);

        // Second and third sessions after cooldown.
        owner.record_interaction(T0 + ENGAGEMENT_COOLDOWN_MS);
        owner.record_interaction(T0 + 2 * ENGAGEMENT_COOLDOWN_MS);
        assert_eq!(store.save_count(), initial_saves + 3);

        // Once threshold is reached, further interactions never touch disk.
        owner.record_interaction(T0 + 10 * ENGAGEMENT_COOLDOWN_MS);
        assert_eq!(store.save_count(), initial_saves + 3);
    }

    #[test]
    fn starred_and_dismissed_persist_permanent_opt_out() {
        let store = MemStore::default();
        let owner =
            StarPromptOwner::with_store(Box::new(store.clone()), Some(T0 - MIN_ELAPSED_MS - 1), T0);
        engage_three_times(&owner, T0);
        assert!(owner.status(T0 + 2 * ENGAGEMENT_COOLDOWN_MS).eligible);

        let after_star = owner
            .act(StarPromptAction::Starred, T0 + 3 * ENGAGEMENT_COOLDOWN_MS)
            .unwrap();
        assert!(!after_star.eligible);

        // Survives restart.
        let reloaded = StarPromptOwner::with_store(Box::new(store), None, T0 + 30 * MIN_ELAPSED_MS);
        assert!(!reloaded.status(T0 + 30 * MIN_ELAPSED_MS).eligible);

        // Dismiss also persists permanently.
        let dismiss_store = MemStore::default();
        let dismiss_owner = StarPromptOwner::with_store(
            Box::new(dismiss_store.clone()),
            Some(T0 - MIN_ELAPSED_MS - 1),
            T0,
        );
        engage_three_times(&dismiss_owner, T0);
        let after_dismiss = dismiss_owner
            .act(StarPromptAction::Dismissed, T0 + 3 * ENGAGEMENT_COOLDOWN_MS)
            .unwrap();
        assert!(!after_dismiss.eligible);
        let reloaded_dismiss =
            StarPromptOwner::with_store(Box::new(dismiss_store), None, T0 + 30 * MIN_ELAPSED_MS);
        assert!(!reloaded_dismiss.status(T0 + 30 * MIN_ELAPSED_MS).eligible);
    }

    #[test]
    fn snooze_hides_for_seven_days_once_then_second_snooze_permanently_dismisses() {
        let store = MemStore::default();
        let owner =
            StarPromptOwner::with_store(Box::new(store.clone()), Some(T0 - MIN_ELAPSED_MS - 1), T0);
        engage_three_times(&owner, T0);
        let snooze_at = T0 + 3 * ENGAGEMENT_COOLDOWN_MS;

        let after_first = owner.act(StarPromptAction::Snoozed, snooze_at).unwrap();
        assert!(!after_first.eligible);
        assert!(!after_first.can_snooze);

        // Still hidden at exact 7d boundary.
        assert!(!owner.status(snooze_at + SNOOZE_DURATION_MS).eligible);
        // Eligible again 1ms after 7d, with can_snooze = false.
        assert_eq!(
            owner.status(snooze_at + SNOOZE_DURATION_MS + 1),
            StarPromptStatus {
                eligible: true,
                can_snooze: false,
            }
        );

        // A second snooze permanently dismisses so it never loops.
        let second_at = snooze_at + SNOOZE_DURATION_MS + 1_000;
        let after_second = owner.act(StarPromptAction::Snoozed, second_at).unwrap();
        assert!(!after_second.eligible);
        assert!(!owner.status(second_at + 30 * SNOOZE_DURATION_MS).eligible);
    }

    #[test]
    fn corrupt_json_recovers_gracefully_and_save_failure_preserves_state() {
        let corrupt = MemStore::with_raw("{not valid json");
        let owner =
            StarPromptOwner::with_store(Box::new(corrupt), Some(T0 - MIN_ELAPSED_MS - 1), T0);
        engage_three_times(&owner, T0);
        assert!(owner.status(T0 + 2 * ENGAGEMENT_COOLDOWN_MS).eligible);

        let failing_store = MemStore::default();
        let owner = StarPromptOwner::with_store(
            Box::new(failing_store.clone()),
            Some(T0 - MIN_ELAPSED_MS - 1),
            T0,
        );
        engage_three_times(&owner, T0);
        failing_store.set_fail_save(true);

        let err = owner
            .act(StarPromptAction::Dismissed, T0 + 3 * ENGAGEMENT_COOLDOWN_MS)
            .unwrap_err();
        assert!(matches!(err, CommandError::SettingsNotSaved { .. }));
        // In-memory state must remain unchanged after a failed save.
        assert!(owner.status(T0 + 3 * ENGAGEMENT_COOLDOWN_MS).eligible);
    }

    #[test]
    fn file_store_round_trips_on_disk_with_owner_only_permissions_and_recovers_from_binary_corrupt()
    {
        let dir = tempfile::tempdir().unwrap();
        let owner = StarPromptOwner::open(dir.path(), Some(T0 - MIN_ELAPSED_MS - 1), T0);
        engage_three_times(&owner, T0);
        owner
            .act(StarPromptAction::Starred, T0 + 3 * ENGAGEMENT_COOLDOWN_MS)
            .unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join(STAR_PROMPT_FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }

        let reloaded = StarPromptOwner::open(dir.path(), None, T0 + 20 * MIN_ELAPSED_MS);
        assert!(!reloaded.status(T0 + 20 * MIN_ELAPSED_MS).eligible);

        // Binary / non-UTF-8 bytes on disk must recover gracefully without panicking.
        let corrupt_dir = tempfile::tempdir().unwrap();
        std::fs::write(
            corrupt_dir.path().join(STAR_PROMPT_FILE),
            [0xff, 0xfe, 0x00, 0x80],
        )
        .unwrap();
        let recovered =
            StarPromptOwner::open(corrupt_dir.path(), Some(T0 - MIN_ELAPSED_MS - 1), T0);
        engage_three_times(&recovered, T0);
        assert!(recovered.status(T0 + 2 * ENGAGEMENT_COOLDOWN_MS).eligible);
    }

    #[test]
    fn existing_first_seen_is_preserved_across_reloads_and_closed_states_skip_interaction_writes() {
        let store = MemStore::default();
        let owner = StarPromptOwner::with_store(Box::new(store.clone()), None, T0);
        engage_three_times(&owner, T0);

        // Reloading with an older history timestamp must keep the persisted first_seen_at_ms.
        let reloaded = StarPromptOwner::with_store(
            Box::new(store.clone()),
            Some(T0 - 10 * MIN_ELAPSED_MS),
            T0 + MIN_ELAPSED_MS,
        );
        assert!(!reloaded.status(T0 + MIN_ELAPSED_MS).eligible);
        assert!(reloaded.status(T0 + MIN_ELAPSED_MS + 1).eligible);

        // Once dismissed or starred before 3 sessions, interactions never touch disk.
        for action in [StarPromptAction::Starred, StarPromptAction::Dismissed] {
            let s = MemStore::default();
            let o = StarPromptOwner::with_store(Box::new(s.clone()), None, T0);
            o.act(action, T0 + 1_000).unwrap();
            let saves_after_act = s.save_count();
            o.record_interaction(T0 + 2 * ENGAGEMENT_COOLDOWN_MS);
            assert_eq!(s.save_count(), saves_after_act);
        }
    }

    #[test]
    fn file_store_creates_missing_parent_dirs_and_leaves_no_temp_siblings() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("nested").join("app-data");
        let store = FileStarPromptStore::in_dir(&nested);

        assert!(store.load().unwrap().is_none());
        store.save("{\"first_seen_at_ms\":1}").unwrap();

        let entries: Vec<String> = std::fs::read_dir(&nested)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec![STAR_PROMPT_FILE.to_string()]);
    }
}
