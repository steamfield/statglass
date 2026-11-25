//! Metric values in the user's units, for rule sentences and alert text. The rules
//! agree with the client's formatters (`packages/core/src/format`) on every alertable metric.

use statglass_schema::settings::{MemoryUnit, TemperatureUnit, UnitSettings};
use statglass_schema::{CATALOG, Unit, alert_metric};

/// What a value that was not measured (NaN or infinite) reads as, as on the client.
const MISSING: &str = "\u{2014}";
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
/// with at most one decimal ("20 GB", "3.7 GiB"). Percent and count entries with a
/// significant-digit limit retain fractional digits and round ties to even. Other units
/// and unknown metrics read as whole numbers with thousands separators. Halves round
/// away from zero in the whole-number formats. A value that is not finite reads as "—".
pub fn format_value(metric: &str, value: f32, units: &UnitSettings) -> String {
    if !value.is_finite() {
        return MISSING.to_owned();
    }
    let unit = catalog_unit(metric);
    if let Some(digits) = alert_metric(metric).and_then(|m| m.value_significant_digits) {
        let shown = significant(value, digits);
        return if unit == Some(Unit::Percent) {
            format!("{shown}%")
        } else {
            shown
        };
    }
    let value = f64::from(value);
    match unit {
        Some(Unit::Percent) => format!("{}%", whole(value)),
        Some(Unit::Watts) => format_watts(value),
        Some(Unit::Rpm) => format!("{} rpm", grouped(value)),
        Some(Unit::PagesPerSec) => format!("{} pages/s", grouped(value)),
        Some(Unit::Celsius) => format_temperature(value, units.temperature),
        Some(Unit::Bytes) => format_bytes(value, binary_bytes(metric, units)),
        _ => grouped(value),
    }
}

/// Round in scientific notation, then put the decimal point back for display.
/// This keeps even very small values and matches Intl's half-even rounding.
fn significant(value: f32, digits: u8) -> String {
    if value == 0.0 {
        return "0".to_owned();
    }
    let precision = usize::from(digits.saturating_sub(1));
    let rounded = format!("{:.precision$e}", value.abs());
    let (mantissa, exponent) = rounded.split_once('e').expect(":e prints an exponent");
    let point = 1 + exponent.parse::<isize>().expect("an f32 exponent fits");
    let offset = point.unsigned_abs();
    let digits = mantissa.replace('.', "");
    let digits = digits.trim_end_matches('0');
    let shown = if point <= 0 {
        format!("0.{}{digits}", "0".repeat(offset))
    } else if offset >= digits.len() {
        format!("{digits}{}", "0".repeat(offset - digits.len()))
    } else {
        let (whole, fraction) = digits.split_at(offset);
        format!("{whole}.{fraction}")
    };
    let grouped = group_decimal(&shown);
    if value < 0.0 {
        format!("-{grouped}")
    } else {
        grouped
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
        format!("{} W", one_decimal(watts))
    } else {
        format!("{} W", whole(watts))
    }
}

fn format_temperature(celsius: f64, unit: TemperatureUnit) -> String {
    match unit {
        TemperatureUnit::Celsius => format!("{} °C", whole(celsius)),
        TemperatureUnit::Fahrenheit => format!("{} °F", whole(celsius * 9.0 / 5.0 + 32.0)),
    }
}

/// Whether `metric`'s bytes read in GiB rather than GB.
fn binary_bytes(metric: &str, units: &UnitSettings) -> bool {
    metric.starts_with(MEMORY_PREFIX) && units.memory == MemoryUnit::Binary
}

fn format_bytes(bytes: f64, binary: bool) -> String {
    if binary {
        format!("{} GiB", trimmed_decimal(bytes / BYTES_PER_GIB))
    } else {
        format!("{} GB", trimmed_decimal(bytes / BYTES_PER_GB))
    }
}

/// `value` with one decimal, the decimal left out when it is zero ("20", "3.7").
fn trimmed_decimal(value: f64) -> String {
    let text = one_decimal(value);
    match text.strip_suffix(".0") {
        Some(whole) => whole.to_owned(),
        None => text,
    }
}

/// `value` rounded to a whole number with a comma between each group of three digits
/// ("12,500").
fn grouped(value: f64) -> String {
    group_decimal(&whole(value))
}

/// Adds separators to the integer part of an already formatted value.
fn group_decimal(text: &str) -> String {
    let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
    let (sign, digits) = match whole.strip_prefix('-') {
        Some(digits) => ("-", digits),
        None => ("", whole),
    };
    let mut out = String::with_capacity(text.len() + digits.len() / 3);
    out.push_str(sign);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            out.push(',');
        }
        out.push(digit);
    }
    if !fraction.is_empty() {
        out.push('.');
        out.push_str(fraction);
    }
    out
}

/// `value` rounded to a whole number, halves away from zero ("81" for 80.5).
fn whole(value: f64) -> String {
    format!("{:.0}", without_negative_zero(value.round()))
}

/// `value` rounded to one decimal, halves away from zero ("7.3" for 7.25).
fn one_decimal(value: f64) -> String {
    format!(
        "{:.1}",
        without_negative_zero((value * 10.0).round() / 10.0)
    )
}

/// `rounded`, with -0 (a small negative value rounded) as 0 so it never prints "-0".
fn without_negative_zero(rounded: f64) -> f64 {
    if rounded == 0.0 { 0.0 } else { rounded }
}

#[cfg(test)]
mod tests {
    use statglass_schema::settings::NetworkUnit;

    use super::*;

    const CELSIUS_DECIMAL: UnitSettings = UnitSettings {
        temperature: TemperatureUnit::Celsius,
        network: NetworkUnit::BytesPerSec,
        memory: MemoryUnit::Decimal,
    };

    const CELSIUS_BINARY: UnitSettings = UnitSettings {
        memory: MemoryUnit::Binary,
        ..CELSIUS_DECIMAL
    };

    /// Exact halves round away from zero, as the client's formatters round them.
    #[test]
    fn halves_round_away_from_zero() {
        let v = |metric, value| format_value(metric, value, &CELSIUS_DECIMAL);
        assert_eq!(v("mem.pressure", 80.5), "81%");
        assert_eq!(v("power.system", 72.5), "73 W");
        assert_eq!(v("power.system", 7.25), "7.3 W");
        assert_eq!(v("fan.rpm", 4000.5), "4,001 rpm");
        assert_eq!(v("thermal.hottest", 94.5), "95 °C");
        assert_eq!(
            format_value("mem.swap_used", 2.25 * 1_073_741_824.0, &CELSIUS_BINARY),
            "2.3 GiB"
        );
    }

    #[test]
    fn a_value_that_is_not_finite_reads_as_missing() {
        let v = |metric, value| format_value(metric, value, &CELSIUS_DECIMAL);
        assert_eq!(v("mem.pressure", f32::NAN), MISSING);
        assert_eq!(v("disk.free", f32::INFINITY), MISSING);
        assert_eq!(v("fan.rpm", f32::NEG_INFINITY), MISSING);
    }

    #[test]
    fn a_small_negative_value_rounds_to_zero_without_a_sign() {
        assert_eq!(format_value("mem.pressure", -0.4, &CELSIUS_DECIMAL), "0%");
        assert_eq!(format_value("fan.rpm", -0.4, &CELSIUS_DECIMAL), "0 rpm");
    }
}
