import { ratio } from "@core/chart-math";
import { formatPercent, MISSING } from "@core/format";
import { batteryTime } from "@core/format/battery";
import type { PowerSource } from "@core/generated/types";
import type { BatterySelection } from "@core/live-selectors";
import {
  describeStats,
  type StatListItem,
} from "@core/widget-models/stat-list";
import type { CardContent, CardSource } from "./types";

export const BATTERY_TITLE = "Battery";
const REMAINING_LABEL = "Remaining";

function powerStatus(source: PowerSource | null): string {
  switch (source) {
    case "charging":
      return "Charging";
    case "adapter":
      return "On power";
    case "battery":
      return "On battery";
    default:
      return "Power state unavailable";
  }
}

export function batteryCard(
  sel: BatterySelection,
  { powerSource = null }: CardSource
): CardContent & {
  headline: string;
  status: string;
  chargeFraction: number | null;
  remainingItems: readonly StatListItem[];
} {
  const headline = formatPercent(sel.charge);
  const time = batteryTime(sel, powerSource);
  const health = { label: "Health", value: formatPercent(sel.health) };
  const cycles = {
    label: "Cycles",
    value: sel.cycles === null ? MISSING : String(Math.round(sel.cycles)),
  };
  const items = [time, health, cycles];
  return {
    title: BATTERY_TITLE,
    headline,
    status: powerStatus(powerSource),
    chargeFraction: ratio(sel.charge, 100),
    remainingItems:
      time.label === REMAINING_LABEL
        ? items
        : [{ ...time, label: REMAINING_LABEL }, health, cycles],
    segments: [],
    items,
    bars: [],
    spoken: describeStats(items),
  };
}
