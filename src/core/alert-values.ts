/// <reference lib="es2023.intl" />

/**
 * Alert rule values in the user's units: one measured or threshold value as
 * text ("84%", "4,000 rpm", "20 GB"), and a threshold converted between its
 * catalog unit and the unit the rule dialog shows (°F, GB, GiB). Rust's
 * `statglass_notify::format_value` uses the same units and grouping.
 */
import {
  bytesParts,
  celsiusToFahrenheit,
  type DisplayUnits,
  displayUnits,
  fixed,
  formatInteger,
  formatPercent,
  formatTemperature,
  isPresent,
  MISSING,
} from "@core/format";
import {
  ALERT_METRICS,
  METRIC_UNITS,
  type UnitSettings,
} from "@core/generated/bindings";

/** A threshold in the unit the user reads it in. */
export interface DisplayThreshold {
  value: number;
  unit: string;
}

/** Watts below this read with one decimal, as Rust's `format_value` does. */
const WATTS_DECIMAL_BELOW = 10;

/** Significant digits an f32 holds; more only shows binary rounding noise. */
const F32_DIGITS = 7;
const significantFormatters = new Map<number, Intl.NumberFormat>();

const BYTES_PER_GB = 1e9;
const BYTES_PER_GIB = 2 ** 30;

/** The unit text of each catalog unit shown without conversion. */
const UNIT_TEXT: Readonly<Record<string, string>> = {
  percent: "%",
  rpm: "rpm",
  watts: "W",
  pages_per_sec: "pages/s",
};

type ByteDisplayUnit = "GB" | "GiB";

/** The catalog unit of `metric`, or undefined for a metric this build lacks. */
function catalogUnit(metric: string): string | undefined {
  return (METRIC_UNITS as Readonly<Record<string, string>>)[metric];
}

/** The byte unit `metric` reads in: memory follows the setting, disk is GB. */
function byteUnitOf(metric: string, units: DisplayUnits): ByteDisplayUnit {
  return metric.startsWith("mem.") ? units.bytes : "GB";
}

/** Bytes in one GB or one GiB. */
function bytesPerUnit(unit: ByteDisplayUnit): number {
  return unit === "GiB" ? BYTES_PER_GIB : BYTES_PER_GB;
}

/** Bytes pinned to GB or GiB with one decimal, a trailing ".0" dropped. */
function formatShortBytes(bytes: number, unit: ByteDisplayUnit): string {
  const parts = bytesParts(bytes, { units: unit, unit, decimals: 1 });
  return `${parts.value.replace(/\.0$/, "")} ${parts.unit}`;
}

function significantDigitsFor(metric: string): number | null {
  return (
    ALERT_METRICS.find((entry) => entry.metric === metric)
      ?.value_significant_digits ?? null
  );
}

function formatSignificant(value: number, digits: number): string {
  let formatter = significantFormatters.get(digits);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-US", {
      maximumSignificantDigits: digits,
      roundingMode: "halfEven",
    });
    significantFormatters.set(digits, formatter);
  }
  // Recover the original f32 from its shortest JSON representation.
  const stored = Math.fround(value);
  return formatter.format(stored === 0 ? 0 : stored);
}

/**
 * One value of `metric` in the user's units: "84%", "203 °F", "3.7 GiB",
 * "4,000 rpm", "1,000 pages/s", "6.5 W". A missing value reads "—"; a
 * metric this build has no unit for reads as a grouped integer. Memory stall
 * and load average retain fractional digits.
 */
export function formatAlertValue(
  metric: string,
  value: number | null,
  units: DisplayUnits
): string {
  if (!isPresent(value)) return MISSING;
  const unit = catalogUnit(metric);
  const digits = significantDigitsFor(metric);
  if (digits !== null) {
    const shown = formatSignificant(value, digits);
    return unit === "percent" ? `${shown}%` : shown;
  }
  switch (unit) {
    case "percent":
      return formatPercent(value);
    case "celsius":
      return formatTemperature(value, { units: units.temperature });
    case "bytes":
      return formatShortBytes(value, byteUnitOf(metric, units));
    case "watts":
      return `${fixed(value, value < WATTS_DECIMAL_BELOW ? 1 : 0)} W`;
    case "rpm":
      return `${formatInteger(value)} rpm`;
    case "pages_per_sec":
      return `${formatInteger(value)} pages/s`;
    default:
      return formatInteger(value);
  }
}

/**
 * A stored threshold (catalog unit) in the unit the user enters it in: °F
 * when set, GB or GiB for bytes (GiB only for `mem.*` with the binary
 * memory setting), the catalog unit otherwise. Rust stores thresholds as
 * f32, so the value is cut to f32 precision (seven significant digits):
 * 200 °F saved and read back shows 200, not 200.00000457763673.
 */
export function thresholdToDisplay(
  metric: string,
  value: number,
  units: UnitSettings
): DisplayThreshold {
  const display = displayUnits(units);
  const unit = catalogUnit(metric);
  const digits = significantDigitsFor(metric);
  if (digits !== null) {
    return {
      value: Number(formatSignificant(value, digits).replaceAll(",", "")),
      unit: UNIT_TEXT[unit ?? ""] ?? "",
    };
  }
  const toF32 = (shown: number) => Number(shown.toPrecision(F32_DIGITS));
  if (unit === "celsius") {
    return display.temperature === "F"
      ? { value: toF32(celsiusToFahrenheit(value)), unit: "°F" }
      : { value: toF32(value), unit: "°C" };
  }
  if (unit === "bytes") {
    const bytesUnit = byteUnitOf(metric, display);
    return { value: toF32(value / bytesPerUnit(bytesUnit)), unit: bytesUnit };
  }
  return { value: toF32(value), unit: UNIT_TEXT[unit ?? ""] ?? "" };
}

/** The inverse of `thresholdToDisplay`: an entered value in the catalog unit. */
export function thresholdFromDisplay(
  metric: string,
  shown: number,
  units: UnitSettings
): number {
  const display = displayUnits(units);
  const unit = catalogUnit(metric);
  if (unit === "celsius" && display.temperature === "F") {
    return ((shown - 32) * 5) / 9;
  }
  if (unit === "bytes") {
    return shown * bytesPerUnit(byteUnitOf(metric, display));
  }
  return shown;
}
