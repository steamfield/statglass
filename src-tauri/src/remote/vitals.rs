//! The same held-frame projection for local and remote host cards (D-134).
use serde::{Deserialize, Serialize};
use statglass_engine::LiveFrame;
use statglass_schema::{Catalog, HostId, HostInfo};

#[derive(Clone, Debug, PartialEq, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MemoryPressure {
    Level { level: u8 },
    Stall { some_pct: f32 },
    Unknown,
}

impl<'de> Deserialize<'de> for MemoryPressure {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(tag = "kind", rename_all = "snake_case")]
        enum Input {
            Level {
                level: u8,
            },
            Stall {
                some_pct: f32,
            },
            #[serde(other)]
            Unknown,
        }
        Ok(match Input::deserialize(deserializer)? {
            Input::Level { level } => Self::Level { level },
            Input::Stall { some_pct } => Self::Stall { some_pct },
            Input::Unknown => Self::Unknown,
        })
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct HostVitals {
    pub cpu_pct: Option<f32>,
    pub memory_pct: Option<f32>,
    pub load_1m: Option<f32>,
    pub cores: Option<u32>,
    pub memory_pressure: Option<MemoryPressure>,
    #[specta(type = Option<statglass_schema::JsSafeInt>)]
    pub disk_used_bytes: Option<u64>,
    #[specta(type = Option<statglass_schema::JsSafeInt>)]
    pub disk_free_bytes: Option<u64>,
    #[specta(type = Option<statglass_schema::JsSafeInt>)]
    pub disk_total_bytes: Option<u64>,
    pub disk_low: bool,
    pub net_rx_bps: Option<f64>,
    pub net_tx_bps: Option<f64>,
}

pub(super) fn host_vitals(frame: Option<&LiveFrame>, host: HostId, info: &HostInfo) -> HostVitals {
    let cores = info
        .cpu_topology
        .iter()
        .map(|c| c.cores.len() as u32)
        .sum::<u32>();
    let mut out = HostVitals {
        cores: (cores > 0).then_some(cores),
        ..Default::default()
    };
    let Some(frame) = frame else { return out };
    let snapshot = match frame.snapshot(host, &Catalog::builtin()) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            tracing::warn!(%error, "invalid host vitals frame");
            return out;
        }
    };
    out.cpu_pct = snapshot.cpu.as_ref().and_then(|cpu| cpu.total);
    if info.mem_total_bytes > 0 {
        out.memory_pct = snapshot
            .memory
            .as_ref()
            .and_then(|memory| memory.used)
            .map(|used| used / info.mem_total_bytes as f32 * 100.0);
    }
    out.load_1m = snapshot
        .cpu
        .as_ref()
        .and_then(|c| c.load_avg.iter().find(|v| v.label == "1")?.value);
    out.memory_pressure = snapshot.memory.as_ref().and_then(|m| {
        m.pressure_level
            .filter(|v| matches!(*v, 0.0 | 1.0 | 2.0))
            .map(|level| MemoryPressure::Level { level: level as u8 })
            .or_else(|| {
                m.psi_some_pct
                    .map(|some_pct| MemoryPressure::Stall { some_pct })
            })
    });
    if let Some(volume) = snapshot
        .disk
        .as_ref()
        .and_then(|d| d.volumes.iter().find(|v| v.vol == "/"))
    {
        let bytes = |v: Option<f32>| v.filter(|v| *v >= 0.0).map(|v| v as u64);
        out.disk_used_bytes = bytes(volume.used);
        out.disk_free_bytes = bytes(volume.free);
        out.disk_total_bytes = bytes(volume.total);
        out.disk_low = out
            .disk_total_bytes
            .zip(out.disk_free_bytes)
            .is_some_and(|(total, free)| free < statglass_store::low_disk_threshold(total));
    }
    if let Some(net) = snapshot.network {
        out.net_rx_bps = net.rx_total_bps.map(f64::from);
        out.net_tx_bps = net.tx_total_bps.map(f64::from);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use statglass_engine::FrameLayout;
    use statglass_schema::{ClusterInfo, CoreKind, OsKind, SeriesKey};
    use std::sync::Arc;

    fn info() -> HostInfo {
        HostInfo {
            os: OsKind::Linux,
            os_version: "6.17".into(),
            model: None,
            chip: None,
            chip_known: true,
            cpu_topology: vec![ClusterInfo {
                name: "cpu".into(),
                kind: CoreKind::Uniform,
                cores: vec!["0".into(), "1".into()],
                dvfs_mhz: vec![],
            }],
            mem_total_bytes: 16_000_000_000,
            boot_time_ms: 0,
            gpu_dvfs_mhz: vec![],
            boot_mounts: vec!["/".into()],
            kernel: None,
        }
    }
    fn vitals(values: &[(&str, f32)]) -> HostVitals {
        let frame = LiveFrame {
            ts_ms: 0,
            interval_ms: 1000,
            timeline: 0,
            layout: Arc::new(FrameLayout {
                layout_no: 1,
                series: values
                    .iter()
                    .map(|(key, _)| SeriesKey::parse(key).unwrap())
                    .collect(),
            }),
            // Display holds must be used, not this tick's raw gaps.
            values: vec![f32::NAN; values.len()].into(),
            held: values.iter().map(|(_, value)| *value).collect(),
            holds: vec![2500; values.len()].into(),
        };
        host_vitals(Some(&frame), HostId(uuid::Uuid::nil()), &info())
    }
    #[test]
    fn linux_host_vitals_preserve_labels_and_every_measured_field() {
        let got = vitals(&[
            ("cpu.loadavg{window=1}", 1.5),
            ("cpu.loadavg{window=5}", 9.0),
            ("mem.psi{stall=some}", 2.5),
            ("mem.psi{stall=full}", 0.5),
            ("disk.used{vol=/}", 6000.0),
            ("disk.free{vol=/}", 4000.0),
            ("disk.total{vol=/}", 10000.0),
            ("disk.free{vol=/data}", 1.0),
            ("net.rx_total", 1234.0),
            ("net.tx_total", 567.0),
        ]);
        assert_eq!(
            got,
            HostVitals {
                cpu_pct: None,
                memory_pct: None,
                load_1m: Some(1.5),
                cores: Some(2),
                memory_pressure: Some(MemoryPressure::Stall { some_pct: 2.5 }),
                disk_used_bytes: Some(6000),
                disk_free_bytes: Some(4000),
                disk_total_bytes: Some(10000),
                disk_low: false,
                net_rx_bps: Some(1234.0),
                net_tx_bps: Some(567.0),
            }
        );
    }
    #[test]
    fn percentages_use_the_same_held_facts_for_local_and_remote_hosts() {
        let got = vitals(&[("cpu.total", 12.5), ("mem.used", 8_000_000_000.0)]);
        assert_eq!(got.cpu_pct, Some(12.5));
        assert_eq!(got.memory_pct, Some(50.0));
        let missing = vitals(&[("cpu.total", f32::NAN), ("mem.used", f32::NAN)]);
        assert_eq!((missing.cpu_pct, missing.memory_pct), (None, None));
        let mut info = info();
        info.mem_total_bytes = 0;
        assert_eq!(
            host_vitals(None, HostId(uuid::Uuid::nil()), &info).memory_pct,
            None
        );
        let frame = LiveFrame {
            ts_ms: 0,
            interval_ms: 1000,
            timeline: 0,
            layout: Arc::new(FrameLayout {
                layout_no: 1,
                series: vec![SeriesKey::parse("mem.used").unwrap()].into(),
            }),
            values: vec![f32::NAN].into(),
            held: vec![8_000_000_000.0].into(),
            holds: vec![2500].into(),
        };
        assert_eq!(
            host_vitals(Some(&frame), HostId(uuid::Uuid::nil()), &info).memory_pct,
            None
        );
    }

    #[test]
    fn macos_pressure_is_a_level() {
        assert_eq!(
            vitals(&[("mem.pressure_level", 1.0)]).memory_pressure,
            Some(MemoryPressure::Level { level: 1 })
        );
    }
    #[test]
    fn missing_load_and_disk_leave_other_vitals_intact() {
        let got = vitals(&[("mem.psi{stall=some}", 0.0), ("net.rx_total", 42.0)]);
        assert_eq!(got.load_1m, None);
        assert_eq!(
            (
                got.disk_used_bytes,
                got.disk_free_bytes,
                got.disk_total_bytes
            ),
            (None, None, None)
        );
        assert_eq!(got.net_rx_bps, Some(42.0));
        assert_eq!(
            got.memory_pressure,
            Some(MemoryPressure::Stall { some_pct: 0.0 })
        );
    }
    #[test]
    fn disk_low_flips_at_the_store_threshold() {
        let total = 10000;
        let threshold = statglass_store::low_disk_threshold(total);
        for (free, low) in [
            (threshold - 1, true),
            (threshold, false),
            (threshold + 1, false),
        ] {
            assert_eq!(
                vitals(&[
                    ("disk.total{vol=/}", total as f32),
                    ("disk.free{vol=/}", free as f32)
                ])
                .disk_low,
                low
            );
        }
    }
    #[test]
    fn gaps_and_non_finite_values_never_become_zero() {
        let got = vitals(&[
            ("cpu.loadavg{window=1}", f32::NAN),
            ("mem.pressure_level", f32::NAN),
            ("disk.free{vol=/}", f32::INFINITY),
            ("net.rx_total", f32::NAN),
            ("net.tx_total", 0.0),
        ]);
        assert_eq!(got.load_1m, None);
        assert_eq!(got.memory_pressure, None);
        assert_eq!(got.disk_free_bytes, None);
        assert_eq!(got.net_rx_bps, None);
        assert_eq!(got.net_tx_bps, Some(0.0));
    }
    #[test]
    fn unknown_pressure_and_update_phases_decode_without_breaking_status() {
        assert_eq!(
            serde_json::from_str::<MemoryPressure>(r#"{"kind":"future_pressure","value":42}"#)
                .unwrap(),
            MemoryPressure::Unknown
        );
        assert_eq!(
            serde_json::from_str::<super::super::UpdatePhase>(r#"{"kind":"future_phase"}"#)
                .unwrap(),
            super::super::UpdatePhase::Unknown
        );
    }
}
