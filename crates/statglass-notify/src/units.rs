//! Metric values in the user's units, for rule sentences and alert text. The rules
//! agree with the client's formatters (`src/core/format`) on every alertable metric.

use statglass_schema::settings::{MemoryUnit, TemperatureUnit, UnitSettings};
use statglass_schema::{CATALOG, Unit};

const BYTES_PER_GB: f64 = 1e9;
const BYTES_PER_GIB: f64 = 1_073_741_824.0;
/// Watts read with one decimal below this, whole above it.
const WATTS_DECIMAL_BELOW: f64 = 10.0;
/// Metrics whose byte values follow the memory unit setting; every other byte metric
/// (disk space) is decimal GB, as Finder shows it.
const MEMORY_PREFIX: &str = "mem.";

/// `value` of `metric`, given in the catalog unit, as the user reads it: percent as a
/// whole number ("84%"), watts with one decimal under 10 and none from 10 ("7.5 W",
/// "72 W"), rpm and pages per second with thousands separators ("4,000 rpm",
/// "1,000 pages/s"), Celsius in the temperature setting as whole degrees ("95 °C",
/// "203 °F"), and bytes in GB, or in GiB for `mem.*` when the memory setting is binary,
/// with at most one decimal ("20 GB", "3.7 GiB"). Any other unit, and a metric this
/// build does not know, reads as a whole number with thousands separators.
pub fn format_value(metric: &str, value: f32, units: &UnitSettings) -> String {
    let value = f64::from(value);
    match catalog_unit(metric) {
        Some(Unit::Percent) => format!("{value:.0}%"),
        Some(Unit::Watts) => format_watts(value),
        Some(Unit::Rpm) => format!("{} rpm", grouped(value)),
        Some(Unit::PagesPerSec) => format!("{} pages/s", grouped(value)),
        Some(Unit::Celsius) => format_temperature(value, units.temperature),
        Some(Unit::Bytes) => format_bytes(value, binary_bytes(metric, units)),
        _ => grouped(value),
    }
}

/// The catalog unit of `metric`, `None` when this build does not know the metric.
fn catalog_unit(metric: &str) -> Option<Unit> {
    CATALOG
        .iter()
        .find(|def| def.id.as_str() == metric)
        .map(|def| def.unit)
}

fn format_watts(watts: f64) -> String {
    if watts < WATTS_DECIMAL_BELOW {
        format!("{watts:.1} W")
    } else {
        format!("{watts:.0} W")
    }
}

fn format_temperature(celsius: f64, unit: TemperatureUnit) -> String {
    match unit {
        TemperatureUnit::Celsius => format!("{celsius:.0} °C"),
        TemperatureUnit::Fahrenheit => format!("{:.0} °F", celsius * 9.0 / 5.0 + 32.0),
    }
}

/// Whether `metric`'s bytes read in GiB rather than GB.
fn binary_bytes(metric: &str, units: &UnitSettings) -> bool {
    metric.starts_with(MEMORY_PREFIX) && units.memory == MemoryUnit::Binary
}

fn format_bytes(bytes: f64, binary: bool) -> String {
    if binary {
        format!("{} GiB", one_decimal(bytes / BYTES_PER_GIB))
    } else {
        format!("{} GB", one_decimal(bytes / BYTES_PER_GB))
    }
}

/// `value` with one decimal, the decimal left out when it is zero ("20", "3.7").
fn one_decimal(value: f64) -> String {
    let text = format!("{value:.1}");
    match text.strip_suffix(".0") {
        Some(whole) => whole.to_owned(),
        None => text,
    }
}

/// `value` rounded to a whole number with a comma between each group of three digits
/// ("12,500").
fn grouped(value: f64) -> String {
    let whole = format!("{value:.0}");
    let (sign, digits) = match whole.strip_prefix('-') {
        Some(digits) => ("-", digits),
        None => ("", whole.as_str()),
    };
    let mut out = String::with_capacity(whole.len() + digits.len() / 3);
    out.push_str(sign);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            out.push(',');
        }
        out.push(digit);
    }
    out
}
