//! Conversions between the wire messages and the engine types used by a session.
use statglass_engine::{EngineStatus, ProcessSample};
use statglass_proto::{SourceStatus, WireProcess};

pub fn status_to_wire(s: &EngineStatus, history_available: bool) -> SourceStatus {
    SourceStatus {
        interval_ms: s.interval_ms,
        paused: s.paused,
        asleep: s.asleep,
        on_battery: s.on_battery,
        low_power_mode: s.low_power_mode,
        backed_off: s.backed_off,
        backgrounded: s.backgrounded,
        display_idle: s.display_idle,
        history_held_until: s.history_held_until,
        performance: s.performance,
        power_source: s.power_source,
        primary_iface: s.primary_iface.as_ref().map(ToString::to_string),
        history_available,
    }
}
pub(crate) fn status_from_wire(s: SourceStatus) -> EngineStatus {
    EngineStatus {
        interval_ms: s.interval_ms,
        paused: s.paused,
        asleep: s.asleep,
        on_battery: s.on_battery,
        low_power_mode: s.low_power_mode,
        backed_off: s.backed_off,
        backgrounded: s.backgrounded,
        display_idle: s.display_idle,
        history_held_until: s.history_held_until,
        performance: s.performance,
        power_source: s.power_source,
        primary_iface: s.primary_iface.map(Into::into),
    }
}
pub(crate) fn process_from_wire(p: WireProcess) -> ProcessSample {
    ProcessSample {
        pid: p.pid,
        start_time_us: p.start_time_us,
        name: p.name.into(),
        cpu_pct: p.cpu_pct,
        mem_bytes: p.mem_bytes,
        compressed_bytes: p.compressed_bytes,
        threads: p.threads,
        idle_wakeups_per_s: p.idle_wakeups_per_s,
        energy: p.energy,
        disk_read_bps: p.disk_read_bps,
        disk_write_bps: p.disk_write_bps,
        user: p.user.into(),
        net_rx_bps: p.net_rx_bps,
        net_tx_bps: p.net_tx_bps,
        gpu_pct: p.gpu_pct,
        ports: p.ports.map(Into::into),
        interval_s: p.interval_s,
        energy_j: p.energy_j,
        app: p.app.map(Into::into),
        app_main: p.app_main,
    }
}
