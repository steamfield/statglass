//! Metric values in the user's units, for rule sentences and alert text.

use statglass_schema::settings::UnitSettings;

/// `value` of `metric`, given in the catalog unit, as the user reads it: percent as a
/// whole number ("84%"), watts with one decimal under 10 and none from 10 ("7.5 W",
/// "72 W"), rpm with thousands separators ("4,000 rpm"), Celsius in the temperature
/// setting as whole degrees ("95 °C", "203 °F"), and bytes in GB, or in GiB for `mem.*`
/// when the memory setting is binary, with at most one decimal ("20 GB", "3.7 GiB").
pub fn format_value(_metric: &str, _value: f32, _units: &UnitSettings) -> String {
    String::new()
}
