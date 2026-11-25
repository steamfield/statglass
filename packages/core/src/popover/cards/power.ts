import { ratio, stackRemainder } from "@core/chart-math";
import { cpuPowerNote } from "@core/cpu-power-source";
import { formatWatts, MISSING } from "@core/format";
import type { PowerSelection } from "@core/live-selectors";
import type { StackBarSegment } from "@core/widget-models/stack-bar";
import { describeStats } from "@core/widget-models/stat-list";
import { batteryCard } from "./battery";
import type { CardContent, CardSource } from "./types";

const SYSTEM_UNIT = "system";

function rail(
  key: string,
  label: string,
  watts: number | null,
  system: number | null,
  step: StackBarSegment["step"]
): StackBarSegment {
  return {
    key,
    label,
    value: formatWatts(watts),
    fraction: ratio(watts, system),
    step,
  };
}

export function powerCard(
  sel: PowerSelection,
  src: CardSource
): CardContent & {
  headline: string;
  unit: string;
  headlineUnit: string | undefined;
  note: string | null;
  hasBattery: boolean;
  battery: ReturnType<typeof batteryCard> | null;
} {
  const { system, cpu, gpu, ane, dram, cpuSource } = sel;
  const headline = formatWatts(system);
  const cpuRail = rail("cpu", "CPU", cpu, system, 1);
  const gpuRail = rail("gpu", "GPU", gpu, system, 2);
  const aneRail = rail("ane", "ANE", ane, system, "hatch");
  const dramRail = rail("dram", "DRAM", dram, system, 3);
  const rest = stackRemainder(system, [cpu, gpu, ane, dram]);
  const items = [
    { label: cpuRail.label, value: cpuRail.value, swatch: cpuRail.step },
    { label: gpuRail.label, value: gpuRail.value, swatch: gpuRail.step },
    {
      label: aneRail.label,
      value: aneRail.value,
      swatch: aneRail.step,
      muted: !ane,
    },
    { label: dramRail.label, value: dramRail.value, swatch: dramRail.step },
  ];
  const note = cpuPowerNote(cpuSource);
  const showBattery = src.showBattery ?? src.battery != null;
  const battery =
    showBattery && src.battery ? batteryCard(src.battery, src) : null;
  return {
    title: showBattery ? "Power & battery" : "Power",
    headline,
    unit: SYSTEM_UNIT,
    headlineUnit: headline === MISSING ? undefined : SYSTEM_UNIT,
    note,
    hasBattery: showBattery,
    battery,
    segments: [
      cpuRail,
      gpuRail,
      aneRail,
      dramRail,
      rail("rest", "Rest of system", rest, system, "track"),
    ],
    items,
    bars: [],
    get spoken() {
      const details = battery
        ? [
            ...items,
            { label: battery.title, value: battery.headline },
            ...battery.items,
          ]
        : items;
      return describeStats(details, note ?? undefined);
    },
  };
}
