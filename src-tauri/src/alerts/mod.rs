//! Alert destinations: the user's ntfy topics and webhooks, the last delivery to each,
//! and sending every local alert to the enabled ones (plan/rfc-alerts.md 6.1, 6.4, 6.5).
//!
//! | Module | Owns |
//! |---|---|
//! | this one | [`AlertsService`]: the destination list and last delivery per destination, behind two locks (`writes` for list changes and the file, `view` for reads and records; take `writes` first); no file or process I/O of its own |
//! | [`store`] | `alert-destinations.json` (atomic, 0600); the only module that touches the file |
//! | [`dispatch`] | an alert event as a [`Message`], sent to each enabled destination off the calling thread, and [`AlertsService::deliver_to`]: one delivery, its failure log and its record |
//! | [`commands`] | the four Tauri commands and the [`commands::AlertDestinationsChanged`] event |
//!
//! # Emitting
//!
//! The service never emits and holds no `AppHandle`, so every entry point runs in a test
//! without Tauri. A method that changes what the window shows returns the new view
//! ([`AlertsService::save`], [`AlertsService::delete`], [`AlertsService::record`]), and
//! the caller emits it outside the locks: the commands after a save or delete, and the
//! production send function ([`dispatch::background_sender`]) after
//! [`AlertsService::deliver_to`] records an outcome.
//! [`AlertsService::on_alert`] takes that send function as a parameter; tests pass one
//! that records what would have been sent.
//!
//! A destination's URL, topic and token are secrets: logs name a destination by its id
//! only.

pub mod commands;
pub mod dispatch;
pub mod store;
#[cfg(test)]
mod tests;

use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;
use statglass_notify::{Message, alert_text};
use statglass_schema::lock::LockExt;
use statglass_schema::settings::UnitSettings;
use statglass_schema::{DeliveryRecord, Destination, DestinationError, Event, MAX_DESTINATIONS};
use uuid::Uuid;

use crate::error::CommandError;
use store::{BadFileChange, Store};

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
///
/// Two locks: `writes` serializes every change to the list together with its file
/// write, so two saves never build on the same old list; `view` is held only to read or
/// swap state, so a slow disk never delays a delivery being recorded or the window
/// reading the list. Lock order is `writes` then `view`.
pub struct AlertsService {
    writes: Mutex<Store>,
    view: Mutex<AlertDestinationsView>,
}

impl AlertsService {
    /// Loads the destinations from `alert-destinations.json` in `dir`. A missing file is
    /// an empty list; an unreadable or malformed one is renamed to
    /// `alert-destinations.json.bad`, logged, and reported once through `load_error`.
    /// Never fails.
    pub fn open(dir: &Path) -> Self {
        let (store, loaded) = Store::open(dir);
        let view = AlertDestinationsView {
            destinations: loaded
                .destinations
                .into_iter()
                .map(|destination| DestinationView {
                    destination,
                    last: None,
                })
                .collect(),
            load_error: loaded.load_error,
        };
        Self {
            writes: Mutex::new(store),
            view: Mutex::new(view),
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
    /// [`CommandError::InvalidArgument`] with the [`DestinationError`] message when it
    /// fails validation, or when it would be destination number [`MAX_DESTINATIONS`] + 1;
    /// [`CommandError::SettingsNotSaved`] when the file cannot be written, leaving the
    /// list in memory unchanged.
    pub fn save(&self, destination: Destination) -> Result<AlertDestinationsView, CommandError> {
        destination.validate().map_err(invalid)?;
        let mut store = self.writes.lock_ok();
        let next = with_saved(self.destinations(), destination).map_err(invalid)?;
        self.write_then_commit(&mut store, next)
    }

    /// Removes the destination with `id` and writes the file.
    ///
    /// # Errors
    ///
    /// [`CommandError::InvalidArgument`] when no destination has `id`;
    /// [`CommandError::SettingsNotSaved`] when the file cannot be written, leaving the
    /// list in memory unchanged.
    pub fn delete(&self, id: Uuid) -> Result<AlertDestinationsView, CommandError> {
        let mut store = self.writes.lock_ok();
        let mut next = self.destinations();
        let before = next.len();
        next.retain(|d| d.id != id);
        if next.len() == before {
            return Err(invalid(DestinationError::UnknownId));
        }
        self.write_then_commit(&mut store, next)
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
        let Some(text) = alert_text(event, units) else {
            return;
        };
        let message = Message::from_alert_text(text, host_name, event.ts_ms);
        // Collected first so `send` runs without the lock: it may record an outcome.
        let enabled: Vec<Destination> = self
            .destinations()
            .into_iter()
            .filter(|d| d.enabled)
            .collect();
        for destination in enabled {
            send(destination, message.clone());
        }
    }

    /// Records the outcome of a delivery to `destination` and returns the new view to
    /// emit. Records land in arrival order, which is completion order; `at_ms` is only
    /// the time shown, since the wall clock can step back. `None`, and nothing changes,
    /// when no destination has its id any more or its address changed since the
    /// delivery started, so an outcome never lands on an address it was not sent to.
    pub fn record(
        &self,
        destination: &Destination,
        record: DeliveryRecord,
    ) -> Option<AlertDestinationsView> {
        let mut view = self.view.lock_ok();
        let entry = view
            .destinations
            .iter_mut()
            .find(|d| d.destination.id == destination.id)?;
        if entry.destination.kind != destination.kind {
            return None;
        }
        entry.last = Some(record);
        Some(view.clone())
    }

    /// The saved destinations, without delivery state.
    fn destinations(&self) -> Vec<Destination> {
        self.view
            .lock_ok()
            .destinations
            .iter()
            .map(|d| d.destination.clone())
            .collect()
    }

    /// Writes `next` to the file, then makes it the list in memory. A destination keeps
    /// its last delivery while its address (`kind`) is unchanged; a rename or a toggle
    /// keeps it, a new URL, topic or token clears it. The file goes first so a failed
    /// write leaves memory as it was: the list in memory is always what is on disk. The
    /// caller holds `writes`, so nothing else changed the list since `next` was built.
    fn write_then_commit(
        &self,
        store: &mut Store,
        next: Vec<Destination>,
    ) -> Result<AlertDestinationsView, CommandError> {
        let bad_file = store
            .write(&next)
            .map_err(|message| CommandError::SettingsNotSaved { message })?;
        let mut view = self.view.lock_ok();
        match bad_file {
            Some(BadFileChange::MovedAside(message)) => view.load_error = Some(message),
            Some(BadFileChange::Removed) => view.load_error = None,
            None => {}
        }
        let previous = std::mem::take(&mut view.destinations);
        view.destinations = next
            .into_iter()
            .map(|destination| DestinationView {
                last: previous
                    .iter()
                    .find(|p| p.destination.id == destination.id)
                    .filter(|p| p.destination.kind == destination.kind)
                    .and_then(|p| p.last.clone()),
                destination,
            })
            .collect();
        Ok(view.clone())
    }
}

/// `destinations` with `destination` in place of the one sharing its id, or appended.
fn with_saved(
    mut destinations: Vec<Destination>,
    destination: Destination,
) -> Result<Vec<Destination>, DestinationError> {
    if let Some(slot) = destinations.iter_mut().find(|d| d.id == destination.id) {
        *slot = destination;
    } else if destinations.len() >= MAX_DESTINATIONS {
        return Err(DestinationError::TooMany);
    } else {
        destinations.push(destination);
    }
    Ok(destinations)
}

/// A refused change as the command error the dialog shows.
fn invalid(error: DestinationError) -> CommandError {
    CommandError::InvalidArgument {
        message: error.to_string(),
    }
}
