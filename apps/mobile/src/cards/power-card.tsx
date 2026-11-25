import { ratio, stackRemainder } from "@core/chart-math";
import { cpuPowerNote } from "@core/cpu-power-source";
import { formatPercent, formatWatts, MISSING } from "@core/format";
import type { StackBarSegment } from "@core/widget-models/stack-bar";
import type { StatListItem } from "@core/widget-models/stat-list";
import { BatteryDetails, batteryStats } from "@/cards/battery-card";
import { ModuleCard } from "@/cards/module-card";
import type { PowerCardProps } from "@/cards/types";
import { Text } from "@/ui/text";
import { StackBar } from "@/widgets/stack-bar";
import { describeStats, StatList } from "@/widgets/stat-list";

export function PowerCard({
  power,
  source,
  battery,
  ...chrome
}: PowerCardProps) {
  const { system, cpu, gpu, ane, dram, cpuSource } = power;
  const headline = formatWatts(system);
  const cpuNote = cpuPowerNote(cpuSource);
  const rest = stackRemainder(system, [cpu, gpu, ane, dram]);
  const items: StatListItem[] = [
    { label: "CPU", value: formatWatts(cpu), swatch: 1 },
    { label: "GPU", value: formatWatts(gpu), swatch: 2 },
    { label: "ANE", value: formatWatts(ane), swatch: "hatch", muted: !ane },
    { label: "DRAM", value: formatWatts(dram), swatch: 3 },
  ];
  const batteryItems = battery ? batteryStats(battery, source) : null;
  const details = describeStats([
    ...items,
    ...(battery && batteryItems
      ? [
          { label: "Battery", value: formatPercent(battery.charge) },
          ...batteryItems,
        ]
      : []),
  ]);
  const segment = (
    key: string,
    label: string,
    watts: number | null,
    step: StackBarSegment["step"]
  ): StackBarSegment => ({
    key,
    label,
    value: formatWatts(watts),
    fraction: ratio(watts, system),
    step,
  });
  return (
    <ModuleCard
      {...chrome}
      title={battery ? "Power & battery" : "Power"}
      accent="power"
      headline={headline}
      unit={headline === MISSING ? undefined : "system"}
      spokenDetails={cpuNote ? `${details}, ${cpuNote}` : details}
    >
      <StackBar
        segments={[
          segment("cpu", "CPU", cpu, 1),
          segment("gpu", "GPU", gpu, 2),
          segment("ane", "ANE", ane, "hatch"),
          segment("dram", "DRAM", dram, 3),
          segment("rest", "Rest of system", rest, "track"),
        ]}
      />
      <StatList layout="grid" items={items} />
      {battery && batteryItems && (
        <BatteryDetails
          charge={battery.charge}
          items={batteryItems}
          showCharge
        />
      )}
      {cpuNote && <Text role="caption">{cpuNote}</Text>}
    </ModuleCard>
  );
}
