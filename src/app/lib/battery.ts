import { formatHoursMinutes, MISSING } from "@core/format";
import type { PowerSource } from "@core/generated/bindings";
import { MINUTE_MS } from "@core/time-grid";
import type { BatteryDetail } from "~/hooks/use-battery";

/** Time to empty on battery, time to full while charging (IOPowerSources). */
export function batteryTime(
  battery: Pick<BatteryDetail, "timeRemainingMin">,
  source: PowerSource | "unknown" | null,
  presentation: "summary" | "page" = "summary"
): { label: string; value: string } {
  const label = source === "charging" ? "To full" : "Remaining";
  // The Battery page has always suppressed adapter estimates and used a dash.
  if (presentation === "page" && source === "adapter")
    return { label, value: MISSING };
  if (battery.timeRemainingMin !== null)
    return {
      label,
      value: formatHoursMinutes(battery.timeRemainingMin * MINUTE_MS),
    };
  return {
    label,
    value:
      presentation === "summary" &&
      (source === "adapter" || source === "charging")
        ? "On power"
        : MISSING,
  };
}
