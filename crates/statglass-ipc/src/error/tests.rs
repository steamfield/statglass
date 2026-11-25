use std::path::PathBuf;

use statglass_store::rusqlite;

use super::*;

fn sqlite(code: i32) -> StoreError {
    StoreError::Sqlite(rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(code),
        None,
    ))
}

#[test]
fn store_errors_map_to_typed_command_errors() {
    let kind = |e: StoreError| {
        serde_json::to_value(CommandError::from(e)).unwrap()["kind"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert_eq!(
        kind(StoreError::Locked {
            path: PathBuf::from("h.sqlite")
        }),
        "store_busy"
    );
    assert_eq!(kind(sqlite(rusqlite::ffi::SQLITE_BUSY)), "store_busy");
    assert_eq!(kind(sqlite(rusqlite::ffi::SQLITE_CORRUPT)), "store_corrupt");
    assert_eq!(kind(sqlite(rusqlite::ffi::SQLITE_NOTADB)), "store_corrupt");
    assert_eq!(
        kind(StoreError::Corrupt("bad blob".into())),
        "store_corrupt"
    );
    assert_eq!(
        kind(StoreError::TooNew {
            found: 9,
            supported: 2
        }),
        "store_too_new"
    );
    assert_eq!(kind(StoreError::WriterGone), "history_unavailable");
    assert_eq!(
        kind(StoreError::Usage(
            "process history changed; restart expansion".into()
        )),
        "invalid_argument"
    );
    assert_eq!(kind(sqlite(rusqlite::ffi::SQLITE_FULL)), "store");
}

#[test]
fn unavailable_reasons_say_why() {
    let json = |e: &StoreError| serde_json::to_value(HistoryUnavailableReason::from(e)).unwrap();
    assert_eq!(
        json(&StoreError::Locked {
            path: PathBuf::from("h")
        }),
        serde_json::json!({ "kind": "locked" })
    );
    assert_eq!(
        json(&StoreError::TooNew {
            found: 9,
            supported: 2
        }),
        serde_json::json!({ "kind": "too_new", "found": 9, "supported": 2 })
    );
    assert_eq!(
        json(&sqlite(rusqlite::ffi::SQLITE_NOTADB))["kind"],
        "corrupt"
    );
    assert_eq!(json(&sqlite(rusqlite::ffi::SQLITE_IOERR))["kind"], "failed");
    // With a reason the error carries it (`null` when unknown).
    let e = CommandError::HistoryUnavailable {
        reason: Some(HistoryUnavailableReason::Locked),
    };
    assert_eq!(
        serde_json::to_value(e).unwrap(),
        serde_json::json!({ "kind": "history_unavailable", "reason": { "kind": "locked" } })
    );
}

#[test]
fn remote_errors_map_to_the_kind_the_ui_acts_on() {
    use statglass_session::{RemoteError, Route, RouteError};
    let json = |e: RemoteError| serde_json::to_value(CommandError::from(e)).unwrap();
    assert_eq!(
        json(RemoteError::AgentNotRunning("studio".into())),
        serde_json::json!({
            "kind": "remote_agent_not_running",
            "message": "StatGlass agent is not running on studio",
        })
    );
    let routes = RemoteError::Routes(vec![RouteError {
        route: Route::Lan,
        host: "studio.local".into(),
        error: RemoteError::Timeout("timed out".into()),
    }]);
    assert_eq!(json(routes)["kind"], "remote_unreachable");
    assert_eq!(
        json(RemoteError::AppNotRunning("studio".into()))["kind"],
        "remote_not_running"
    );
    assert_eq!(
        json(RemoteError::MonitoringOff("studio".into()))["kind"],
        "remote_monitoring_off"
    );
}
