use super::*;
use crate::hosts::HostRegistry;
use crate::process_signal::DesktopRefusals;
use serde_json::{Value, json};
use statglass_engine::{BusMsg, EngineStatus, FrameLayout, LiveFrame, ProcessBatch, ProcessSample};
use statglass_schema::{Capabilities, HostRecord, SeriesKey};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::mpsc;
use uuid::Uuid;

fn registry(visible: &[&str]) -> LiveRegistry {
    let registry = LiveRegistry::new();
    for label in visible {
        registry.window_visible(label, true);
    }
    registry
}

fn sink() -> (Arc<TauriSink>, mpsc::UnboundedReceiver<InvokeResponseBody>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let channel = Channel::new(move |message| {
        tx.send(message)
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::BrokenPipe).into())
    });
    (Arc::new(TauriSink(channel)), rx)
}

fn no_backfill() -> LiveRequest {
    LiveRequest {
        backfill_ms: 0,
        ..Default::default()
    }
}

async fn through_kind(
    rx: &mut mpsc::UnboundedReceiver<InvokeResponseBody>,
    kind: &str,
) -> Vec<Value> {
    tokio::time::timeout(Duration::from_secs(1), async {
        let mut messages = Vec::new();
        loop {
            let message = rx.recv().await.unwrap().deserialize::<Value>().unwrap();
            let done = message["kind"] == kind;
            messages.push(message);
            if done {
                return messages;
            }
        }
    })
    .await
    .unwrap()
}

#[derive(Clone)]
struct RecordingSource {
    record: statglass_schema::HostRecord,
    detail: Arc<Mutex<Vec<bool>>>,
}

#[tokio::test(start_paused = true)]
async fn a_remote_screen_lock_does_not_suspend_the_controllers_live_frames() {
    for is_local in [false, true] {
        let record: statglass_schema::HostRecord = serde_json::from_value(serde_json::json!({
            "id": Uuid::new_v4(), "is_local": is_local, "display_name": "test",
            "info": {"os": "mac_os", "os_version": "test", "model": null, "chip": null,
            "chip_known": false, "cpu_topology": [], "mem_total_bytes": 1024, "boot_time_ms": 0}
        }))
        .unwrap();
        let source = Arc::new(RecordingSource {
            record: record.clone(),
            detail: Arc::default(),
        });
        let hosts = HostRegistry::new();
        let host = hosts.insert(record, source);
        host.hub().publish(BusMsg::Status(EngineStatus {
            interval_ms: 1000,
            ..Default::default()
        }));
        let reg = registry(&["dashboard"]);
        let (sink, mut rx) = sink();
        let id = sink.0.id();
        let subscription = reg
            .subscribe("dashboard", host.clone(), sink, no_backfill())
            .unwrap();
        assert_eq!(subscription.stream, id);
        while rx.try_recv().is_ok() {}
        host.hub().publish(BusMsg::Status(EngineStatus {
            interval_ms: 1000,
            display_idle: true,
            ..Default::default()
        }));
        host.hub().publish(BusMsg::Frame(Arc::new(LiveFrame {
            ts_ms: 1000,
            interval_ms: 1000,
            layout: Arc::new(FrameLayout {
                layout_no: 1,
                series: vec![SeriesKey::parse("cpu.total").unwrap()].into(),
            }),
            timeline: 0,
            values: vec![42.0].into(),
            held: vec![42.0].into(),
            holds: vec![2500].into(),
        })));
        // Caps still goes out while the display is idle and follows the frame on the bus.
        host.hub().publish(BusMsg::Caps(Arc::new(Capabilities {
            revision: 1,
            ..Default::default()
        })));
        let messages = through_kind(&mut rx, "caps").await;
        assert_eq!(
            messages
                .iter()
                .any(|m| m["kind"] == "frame" && m["ts_ms"] == 1000),
            !is_local,
            "only this Mac's display may suspend a visible window's frames"
        );
        assert_eq!(
            messages
                .iter()
                .any(|m| m["kind"] == "status" && m["display_idle"] == true),
            is_local
        );
        assert!(
            host.hub().status().display_idle,
            "the source's actual state stays intact"
        );
        reg.window_closed("dashboard");
    }
}

impl statglass_engine::Source for RecordingSource {
    fn host(&self) -> statglass_schema::HostRecord {
        self.record.clone()
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }
    fn start(
        self: Arc<Self>,
        _: statglass_engine::SourceSink,
    ) -> Result<statglass_engine::SourceHandle, statglass_engine::SourceError> {
        Ok(statglass_engine::SourceHandle::new(Box::new(
            (*self).clone(),
        )))
    }
}

impl statglass_engine::SourceControl for RecordingSource {
    fn set_paused(&self, _: bool) {}
    fn set_process_interest(&self, _: Option<u32>) {}
    fn set_network_process_interest(&self, _: bool) {}
    fn set_gpu_process_interest(&self, _: bool) {}
    fn set_port_process_interest(&self, _: bool) {}
    fn set_network_history(&self, _: bool) {}
    fn set_detail_interest(&self, interested: bool) {
        self.detail.lock().unwrap().push(interested);
    }
    fn apply_settings(&self, _: &statglass_schema::Settings) {}
    fn set_store(&self, _: Option<statglass_store::Writer>) {}
    fn status(&self) -> EngineStatus {
        EngineStatus::default()
    }
    fn stop(&mut self) {}
}

#[tokio::test(start_paused = true)]
async fn real_host_entry_balances_engine_detail_across_windows_and_process_updates() {
    let record: statglass_schema::HostRecord = serde_json::from_value(serde_json::json!({
        "id": Uuid::new_v4(), "is_local": false, "display_name": "test",
        "info": {"os": "linux", "os_version": "test", "model": null, "chip": null,
        "chip_known": false, "cpu_topology": [], "mem_total_bytes": 1024, "boot_time_ms": 0}
    }))
    .unwrap();
    let detail = Arc::new(Mutex::new(Vec::new()));
    let source = Arc::new(RecordingSource {
        record: record.clone(),
        detail: detail.clone(),
    });
    let hosts = HostRegistry::new();
    let host = hosts.insert(record, source);
    host.start(None).unwrap();
    let reg = registry(&["dashboard", "popover"]);
    let mut receivers = Vec::new();
    for label in ["dashboard", "popover"] {
        let (sink, rx) = sink();
        receivers.push(rx);
        reg.subscribe(label, host.clone(), sink, no_backfill())
            .unwrap();
    }
    reg.set_process_interest(
        "dashboard",
        host.clone(),
        Some(statglass_engine::ProcessView {
            period_ms: Some(1000),
            ..Default::default()
        }),
        None,
    );
    reg.window_visible("popover", false);
    assert_eq!(*detail.lock().unwrap(), vec![true]);
    reg.window_closed("dashboard");
    assert_eq!(*detail.lock().unwrap(), vec![true, false]);
}

#[tokio::test(start_paused = true)]
async fn desktop_live_processes_carry_refusals_and_the_default_registry_does_not() {
    let record: HostRecord = crate::test_support::mac_host(42);
    let source = Arc::new(RecordingSource {
        record: record.clone(),
        detail: Arc::default(),
    });
    let hosts = HostRegistry::new();
    let host = hosts.insert(record, source);
    let row = ProcessSample {
        pid: i32::MAX - 1,
        start_time_us: 1,
        name: "kernel_task".into(),
        app: None,
        app_main: false,
        cpu_pct: 0.0,
        mem_bytes: 0,
        compressed_bytes: None,
        threads: 1,
        idle_wakeups_per_s: 0.0,
        energy: 0.0,
        energy_j: 0.0,
        interval_s: 1.0,
        disk_read_bps: 0.0,
        disk_write_bps: 0.0,
        net_rx_bps: None,
        net_tx_bps: None,
        gpu_pct: None,
        ports: None,
        user: "root".into(),
    };
    for (registry, refused) in [
        (
            LiveRegistry::with_refusals(Arc::new(DesktopRefusals)),
            json!("kernel_task"),
        ),
        (LiveRegistry::new(), Value::Null),
    ] {
        registry.window_visible("dashboard", true);
        let (sink, mut rx) = sink();
        let sub = registry
            .subscribe("dashboard", host.clone(), sink, no_backfill())
            .unwrap();
        registry.set_process_interest(
            "dashboard",
            host.clone(),
            Some(Default::default()),
            Some(sub.stream),
        );
        host.hub().publish(BusMsg::Processes(Arc::new(ProcessBatch {
            ts_ms: 1000,
            rows: vec![
                row.clone(),
                ProcessSample {
                    pid: i32::MAX - 2,
                    name: "Safari".into(),
                    ..row.clone()
                },
            ],
            gpu_span_ms: None,
        })));
        let messages = through_kind(&mut rx, "processes").await;
        let rows = messages.last().unwrap()["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows.iter()
                .find(|row| row["name"] == "kernel_task")
                .unwrap()
                .get("refusal"),
            Some(&refused)
        );
        assert_eq!(
            rows.iter()
                .find(|row| row["name"] == "Safari")
                .unwrap()
                .get("refusal"),
            Some(&Value::Null)
        );
        registry.window_closed("dashboard");
    }
}
