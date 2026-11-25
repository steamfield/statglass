//! The metrics a custom alert rule may watch, with the defaults a new rule starts from
//! and the threshold range [`crate::AlertRule::validate_custom`] accepts. Published to
//! TypeScript as the generated constant `ALERT_METRICS`, so the Alerts page offers
//! exactly what Rust accepts. Values are in the metric's catalog unit (percent, bytes,
//! pages per second, Celsius, rpm, watts).

use serde::Serialize;

use crate::alert::Cmp;

/// One alertable metric.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, specta::Type)]
pub struct AlertMetric {
    /// The catalog metric id.
    pub metric: &'static str,
    /// What the metric is called in rule sentences and notifications.
    pub label: &'static str,
    /// The comparison a new rule starts with.
    pub default_op: Cmp,
    /// The threshold a new rule starts with, in the catalog unit.
    pub default_value: f32,
    /// How long a new rule's condition must hold, in seconds.
    pub default_for_secs: u32,
    /// The lowest threshold a rule may use.
    pub min: f32,
    /// The highest threshold a rule may use.
    pub max: f32,
    /// The series a new rule watches, as a `(key, value)` label, or `None` for every
    /// series of the metric. Disk rules start on the boot volume so a mounted installer
    /// image, which is always full, does not fire them.
    pub default_label: Option<(&'static str, &'static str)>,
}

const fn entry(
    metric: &'static str,
    label: &'static str,
    default_op: Cmp,
    default_value: f32,
    default_for_secs: u32,
    min: f32,
    max: f32,
) -> AlertMetric {
    AlertMetric {
        metric,
        label,
        default_op,
        default_value,
        default_for_secs,
        min,
        max,
        default_label: None,
    }
}

/// Every alertable metric, in the order the metric picker lists them.
pub const ALERT_METRICS: &[AlertMetric] = &[
    entry("cpu.total", "CPU usage", Cmp::Gt, 90.0, 300, 1.0, 100.0),
    AlertMetric {
        default_label: Some(("window", "5")),
        ..entry(
            "cpu.loadavg",
            "Load average",
            Cmp::Gt,
            4.0,
            300,
            0.1,
            1000.0,
        )
    },
    entry("gpu.util", "GPU usage", Cmp::Gt, 90.0, 300, 1.0, 100.0),
    entry(
        "mem.pressure",
        "Memory pressure",
        Cmp::Gt,
        80.0,
        120,
        1.0,
        100.0,
    ),
    entry("mem.swap_used", "Swap used", Cmp::Gt, 4e9, 300, 1e8, 1e12),
    // Pages per second leaving memory for swap: the direct sign of thrashing, where
    // swap used can sit high for days without any.
    entry(
        "mem.swap_out",
        "Swapping out",
        Cmp::Gt,
        1000.0,
        120,
        1.0,
        1e6,
    ),
    AlertMetric {
        default_label: Some(("stall", "some")),
        ..entry("mem.psi", "Memory stall", Cmp::Gt, 10.0, 120, 0.01, 100.0)
    },
    entry(
        "thermal.hottest",
        "Hottest sensor",
        Cmp::Gt,
        95.0,
        120,
        30.0,
        130.0,
    ),
    entry(
        "fan.rpm",
        "Fan speed",
        Cmp::Gt,
        4000.0,
        120,
        500.0,
        20_000.0,
    ),
    entry(
        "power.system",
        "System power",
        Cmp::Gt,
        60.0,
        300,
        1.0,
        1000.0,
    ),
    entry(
        "battery.charge",
        "Battery charge",
        Cmp::Lt,
        20.0,
        0,
        1.0,
        100.0,
    ),
    AlertMetric {
        default_label: Some(("vol", "/")),
        ..entry("disk.free", "Free disk space", Cmp::Lt, 20e9, 0, 1e8, 1e14)
    },
];

/// The [`ALERT_METRICS`] entry for `metric`, `None` when rules cannot watch it.
pub fn alert_metric(metric: &str) -> Option<&'static AlertMetric> {
    ALERT_METRICS.iter().find(|m| m.metric == metric)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::Catalog;

    /// Every entry names a catalog metric, its default sits inside its range, and a
    /// default label uses a key the metric carries.
    #[test]
    fn entries_match_the_catalog() {
        let catalog = Catalog::builtin();
        for m in ALERT_METRICS {
            let def = catalog
                .defs()
                .iter()
                .find(|d| d.id.as_str() == m.metric)
                .unwrap_or_else(|| panic!("{} is not in the catalog", m.metric));
            assert!(
                m.min <= m.default_value && m.default_value <= m.max,
                "{m:?}"
            );
            if let Some((key, _)) = m.default_label {
                assert_eq!(def.label_keys, [key], "{m:?}");
            }
        }
        assert_eq!(
            alert_metric("disk.free").unwrap().default_label,
            Some(("vol", "/"))
        );
        assert_eq!(alert_metric("cpu.user"), None);
    }

    #[test]
    fn linux_metrics_have_the_expected_defaults_and_picker_order() {
        for (after, expected) in [
            (
                "cpu.total",
                AlertMetric {
                    metric: "cpu.loadavg",
                    label: "Load average",
                    default_op: Cmp::Gt,
                    default_value: 4.0,
                    default_for_secs: 300,
                    min: 0.1,
                    max: 1000.0,
                    default_label: Some(("window", "5")),
                },
            ),
            (
                "mem.swap_out",
                AlertMetric {
                    metric: "mem.psi",
                    label: "Memory stall",
                    default_op: Cmp::Gt,
                    default_value: 10.0,
                    default_for_secs: 120,
                    min: 0.01,
                    max: 100.0,
                    default_label: Some(("stall", "some")),
                },
            ),
        ] {
            assert_eq!(alert_metric(expected.metric), Some(&expected));
            assert!(
                ALERT_METRICS
                    .windows(2)
                    .any(|pair| { pair[0].metric == after && pair[1].metric == expected.metric })
            );
        }
    }
}
