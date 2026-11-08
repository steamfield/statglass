import { formatHoursMinutes, MISSING } from "@core/format";
import type { PowerSource } from "@core/generated/bindings";
import { MINUTE_MS } from "@core/time-grid";

/** Time to empty on battery, time to full while charging (IOPowerSources). */
export function batteryTime(
  battery: { timeRemainingMin: number | null },
  source: PowerSource | null
): { label: string; value: string } {
  const label = source === "charging" ? "To full" : "Remaining";
  if (battery.timeRemainingMin !== null)
    return {
      label,
      value: formatHoursMinutes(battery.timeRemainingMin * MINUTE_MS),
    };
  return {
    label,
    value: source === "adapter" || source === "charging" ? "On power" : MISSING,
  };
}
