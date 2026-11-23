//! Alert destinations: the user's ntfy topics and webhooks, the last delivery to each,
//! and sending every local alert to the enabled ones (plan/rfc-alerts.md 6.1, 6.4, 6.5).
//!
//! | Module | Owns |
//! |---|---|
//! | this one | [`AlertsService`]: the destination list and last delivery per destination, behind one lock; no file or process I/O of its own |
//! | [`store`] | `alert-destinations.json` (atomic, 0600); the only module that touches the file |
//! | [`dispatch`] | an alert event as a [`Message`], sent to each enabled destination off the calling thread |
//! | [`commands`] | the four Tauri commands and the [`commands::AlertDestinationsChanged`] event |
//!
//! # Emitting
//!
//! The service never emits and holds no `AppHandle`, so every entry point runs in a test
//! without Tauri. A method that changes what the window shows returns the new view
//! ([`AlertsService::save`], [`AlertsService::delete`], [`AlertsService::record`]), and
//! the caller emits it outside the lock: the commands after a save or delete, and the
//! production send function ([`dispatch::background_sender`]) after recording an outcome.
//! [`AlertsService::on_alert`] takes that send function as a parameter; tests pass one
//! that records what would have been sent.
//!
//! A destination's URL, topic and token are secrets: logs name a destination by its id
//! only.

pub mod commands;
pub mod dispatch;
pub mod store;

use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;
use statglass_notify::Message;
use statglass_schema::lock::LockExt;
use statglass_schema::settings::UnitSettings;
use statglass_schema::{DeliveryRecord, Destination, Event};
use uuid::Uuid;

use crate::error::CommandError;

pub use dispatch::{background_sender, send_test};

/// Every destination with its last delivery, as the Alerts page shows them.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, specta::Type)]
pub struct AlertDestinationsView {
    /// In the order they were added. Returned in full, tokens included: this is the
    /// user's own window.
    pub destinations: Vec<DestinationView>,
    /// Why the destinations file could not be read at launch (it was moved aside to
    /// `alert-destinations.json.bad`), `None` when it loaded or did not exist.
    pub load_error: Option<String>,
}

/// One destination and the last delivery to it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
pub struct DestinationView {
    pub destination: Destination,
    /// `None` until something has been sent to it since launch.
    pub last: Option<DeliveryRecord>,
}

/// Owner of the alert destinations and their delivery state. Thread-safe; held in
/// `AppState`.
pub struct AlertsService {
    view: Mutex<AlertDestinationsView>,
}

impl AlertsService {
    /// Loads the destinations from `alert-destinations.json` in `dir`. A missing file is
    /// an empty list; an unreadable or malformed one is renamed to
    /// `alert-destinations.json.bad`, logged, and reported once through `load_error`.
    /// Never fails.
    pub fn open(dir: &Path) -> Self {
        let _ = dir;
        Self {
            view: Mutex::new(AlertDestinationsView::default()),
        }
    }

    /// The destinations and their last deliveries.
    pub fn view(&self) -> AlertDestinationsView {
        self.view.lock_ok().clone()
    }

    /// Adds `destination`, or replaces the one with its id, and writes the file.
    ///
    /// # Errors
    ///
    /// [`CommandError::InvalidArgument`] with the [`statglass_schema::DestinationError`]
    /// message when it fails validation, or when it would be destination number
    /// [`statglass_schema::MAX_DESTINATIONS`] + 1; [`CommandError::SettingsNotSaved`] when
    /// the file cannot be written, leaving the list in memory unchanged.
    pub fn save(&self, destination: Destination) -> Result<AlertDestinationsView, CommandError> {
        let _ = destination;
        Err(not_implemented())
    }

    /// Removes the destination with `id` and writes the file.
    ///
    /// # Errors
    ///
    /// [`CommandError::InvalidArgument`] when no destination has `id`;
    /// [`CommandError::SettingsNotSaved`] when the file cannot be written, leaving the
    /// list in memory unchanged.
    pub fn delete(&self, id: Uuid) -> Result<AlertDestinationsView, CommandError> {
        let _ = id;
        Err(not_implemented())
    }

    /// Hands the message for `event` to `send` once per enabled destination. The message
    /// comes from [`statglass_notify::alert_text`] in `units`, with `host_name` and the
    /// event's time; an event that has no alert text sends nothing. Returns at once:
    /// `send` decides where the delivery runs.
    pub fn on_alert(
        &self,
        event: &Event,
        host_name: &str,
        units: &UnitSettings,
        send: impl Fn(Destination, Message),
    ) {
        let _ = (event, host_name, units, send);
    }

    /// Records the outcome of a delivery to destination `id` and returns the new view to
    /// emit. `None`, and nothing changes, when no destination has `id` or the destination
    /// already holds a record with a later `at_ms` (deliveries can finish out of order).
    pub fn record(&self, id: Uuid, record: DeliveryRecord) -> Option<AlertDestinationsView> {
        let _ = (id, record);
        None
    }
}

/// The placeholder error of the scaffold's stubs.
fn not_implemented() -> CommandError {
    CommandError::Internal {
        message: "not implemented".into(),
    }
}
