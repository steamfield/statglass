//! Reads and writes `alert-destinations.json` under the app data directory: the only
//! module that touches the file. The file holds `{ "destinations": [...] }` and is
//! written atomically with owner-only permissions (0600), as `star_prompt.rs` writes
//! its file, because destinations hold secrets. A file that cannot be read or decoded is
//! renamed to [`BAD_FILE`] so the next save does not overwrite what the user had.
//!
//! Error text never quotes the file's contents: a decode error is reported by its
//! category and position only, since serde's own message can repeat a stored value.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use statglass_schema::Destination;

/// The destinations file, under the app data directory.
pub const DESTINATIONS_FILE: &str = "alert-destinations.json";

/// Where an unreadable or malformed destinations file is moved at launch.
pub const BAD_FILE: &str = "alert-destinations.json.bad";

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// The file's shape, as read.
#[derive(Deserialize)]
struct DestinationsFile {
    destinations: Vec<Destination>,
}

/// The file's shape, as written.
#[derive(Serialize)]
struct DestinationsFileRef<'a> {
    destinations: &'a [Destination],
}

/// What [`Store::open`] found.
pub struct Loaded {
    /// The saved destinations; empty when the file was missing or bad.
    pub destinations: Vec<Destination>,
    /// Why the file could not be used, and where it went. `None` when it loaded or
    /// did not exist.
    pub load_error: Option<String>,
}

/// The destinations file in one directory. Not thread-safe on its own: the service
/// serializes every write through one lock.
pub struct Store {
    path: PathBuf,
    bad_path: PathBuf,
    /// A bad file is still at [`DESTINATIONS_FILE`] because moving it aside failed at
    /// launch. Until it moves, a write would destroy it, so writes are refused.
    bad_file_in_place: bool,
}

impl Store {
    /// Reads the destinations file in `dir`. A file that cannot be read or decoded is
    /// moved to [`BAD_FILE`] and reported through [`Loaded::load_error`], also logged.
    pub fn open(dir: &Path) -> (Self, Loaded) {
        let mut store = Self {
            path: dir.join(DESTINATIONS_FILE),
            bad_path: dir.join(BAD_FILE),
            bad_file_in_place: false,
        };
        let loaded = match store.read() {
            Ok(destinations) => Loaded {
                destinations,
                load_error: None,
            },
            Err(cause) => Loaded {
                destinations: Vec::new(),
                load_error: Some(store.set_aside(&cause)),
            },
        };
        (store, loaded)
    }

    /// Replaces the file with `destinations`, atomically and owner-only.
    ///
    /// # Errors
    ///
    /// A sentence naming the step that failed, when the bad file from launch still
    /// cannot be moved aside or the new file cannot be written. The old file is intact.
    pub fn write(&mut self, destinations: &[Destination]) -> Result<(), String> {
        if self.bad_file_in_place {
            std::fs::rename(&self.path, &self.bad_path).map_err(|e| {
                format!("{DESTINATIONS_FILE} could not be read at launch and moving it to {BAD_FILE} failed ({e}), so it was not overwritten")
            })?;
            self.bad_file_in_place = false;
        }
        let encoded = serde_json::to_string_pretty(&DestinationsFileRef { destinations })
            .map_err(|e| format!("encoding {DESTINATIONS_FILE}: {e}"))?;
        write_atomically(&self.path, &encoded)
    }

    /// The saved destinations; an empty list when there is no file.
    fn read(&self) -> Result<Vec<Destination>, String> {
        let bytes = match std::fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("reading it failed: {e}")),
        };
        serde_json::from_slice::<DestinationsFile>(&bytes)
            .map(|file| file.destinations)
            .map_err(|e| describe_decode_error(&e))
    }

    /// Moves a bad file to [`BAD_FILE`], logs why, and returns the `load_error` text.
    fn set_aside(&mut self, cause: &str) -> String {
        let message = match std::fs::rename(&self.path, &self.bad_path) {
            Ok(()) => format!(
                "{DESTINATIONS_FILE} could not be used ({cause}); it was moved to {BAD_FILE}"
            ),
            Err(e) => {
                self.bad_file_in_place = true;
                format!(
                    "{DESTINATIONS_FILE} could not be used ({cause}) and moving it to {BAD_FILE} failed ({e}); it is left in place and will not be overwritten"
                )
            }
        };
        tracing::warn!("{message}");
        message
    }
}

/// A decode error by category and position, without serde's text, which can quote a
/// stored value such as a token.
fn describe_decode_error(error: &serde_json::Error) -> String {
    let kind = match error.classify() {
        serde_json::error::Category::Io => "read error",
        serde_json::error::Category::Syntax => "invalid JSON",
        serde_json::error::Category::Data => "unexpected contents",
        serde_json::error::Category::Eof => "file ends early",
    };
    format!("{kind} at line {} column {}", error.line(), error.column())
}

/// Writes `content` to a 0600 temp file beside `path` and renames it over `path`, so a
/// reader sees the old file or the new one, never a partial one.
fn write_atomically(path: &Path, content: &str) -> Result<(), String> {
    let temp = temp_path_for(path);
    let result = write_temp_file(&temp, content).and_then(|()| {
        std::fs::rename(&temp, path).map_err(|e| format!("replacing {DESTINATIONS_FILE}: {e}"))
    });
    if result.is_err() {
        // The temp file may not exist (creating it failed); nothing to report then.
        let _ = std::fs::remove_file(&temp);
    }
    result
}

fn temp_path_for(path: &Path) -> PathBuf {
    let seq = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let name = format!(".{DESTINATIONS_FILE}.tmp.{}.{seq}", std::process::id());
    path.with_file_name(name)
}

fn write_temp_file(temp: &Path, content: &str) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(temp)
        .map_err(|e| format!("creating {}: {e}", temp.display()))?;
    file.write_all(content.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|e| format!("writing {}: {e}", temp.display()))?;
    drop(file);
    // Restricted before the rename, so the real name never has group or other bits
    // even if the open mode above stops being the only guard.
    statglass_store::restrict(temp).map_err(|e| format!("restricting {}: {e}", temp.display()))
}
