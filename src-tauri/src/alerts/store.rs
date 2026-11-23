//! Reads and writes `alert-destinations.json` under the app data directory: the only
//! module that touches the file. The file holds `{ "destinations": [...] }` and is
//! written atomically with owner-only permissions (0600), as `star_prompt.rs` writes
//! its file, because destinations hold secrets. A file that cannot be read or decoded is
//! renamed to [`BAD_FILE`] so the next save does not overwrite what the user had.

/// The destinations file, under the app data directory.
pub const DESTINATIONS_FILE: &str = "alert-destinations.json";

/// Where an unreadable or malformed destinations file is moved at launch.
pub const BAD_FILE: &str = "alert-destinations.json.bad";
