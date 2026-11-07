import type { UnitSettings } from "@core/generated/bindings";
import type { ByteUnits, RateUnits } from "./bytes";
import type { TemperatureUnits } from "./temperature";

/** The Units settings as the formatters' option values. */
export interface DisplayUnits {
  rate: RateUnits;
  bytes: ByteUnits;
  temperature: TemperatureUnits;
}

/**
 * The Units settings (plan 4.15) as formatter units. Display only; before
 * settings arrive (`null`), the defaults: MB/s, GB and °F, as the tray uses.
 */
export function displayUnits(units: UnitSettings | null): DisplayUnits {
  return {
    rate: units?.network === "bits_per_sec" ? "Mbps" : "MBps",
    bytes: units?.memory === "binary" ? "GiB" : "GB",
    temperature: units?.temperature === "celsius" ? "C" : "F",
  };
}
