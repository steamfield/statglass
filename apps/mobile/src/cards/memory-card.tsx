import { ratio } from "@core/chart-math";
import {
  bytesParts,
  formatBytes,
  formatPercent,
  MISSING,
  marketingGb,
} from "@core/format";
import { METRIC_CODES } from "@core/generated/types";
import type { StackBarSegment } from "@core/widget-models/stack-bar";
import { View } from "react-native";
import { ModuleCard, StatusIcon } from "@/cards/module-card";
import type { MemoryCardProps } from "@/cards/types";
import { InlineBar } from "@/widgets/inline-bar";
import { StackBar } from "@/widgets/stack-bar";
import { describeStats } from "@/widgets/stat-list";

const PRESSURE_LEVELS = METRIC_CODES["mem.pressure_level"];

function pressureLabel(level: number | null) {
  switch (level) {
    case PRESSURE_LEVELS.critical:
      return "Pressure · critical";
    case PRESSURE_LEVELS.warn:
      return "Pressure · warn";
    case PRESSURE_LEVELS.normal:
      return "Pressure · normal";
    default:
      return "Pressure";
  }
}

export function MemoryCard({ memory, totalBytes, ...chrome }: MemoryCardProps) {
  const used =
    memory.used === null
      ? MISSING
      : bytesParts(memory.used, { unit: "GB", decimals: 1 }).value;
  const segment = (
    key: string,
    label: string,
    bytes: number | null,
    step: StackBarSegment["step"]
  ): StackBarSegment => ({
    key,
    label,
    value: formatBytes(bytes),
    fraction: ratio(bytes, totalBytes),
    step,
  });
  const segments = [
    ...(memory.composition
      ? [
          segment("wired", "Wired", memory.wired, 1),
          segment("app", "App", memory.app, 2),
          segment("compressed", "Compressed", memory.compressed, "hatch"),
        ]
      : [segment("used", "Used", memory.used, 1)]),
    segment("cached", "Cached files", memory.cached, 4),
    segment("free", "Free", memory.free, "track"),
  ];
  const swap = { label: "Swap", value: formatBytes(memory.swapUsed) };
  const pressure = {
    label: pressureLabel(memory.pressureLevel),
    value: formatPercent(memory.pressure),
  };
  const status =
    memory.pressureLevel === PRESSURE_LEVELS.critical
      ? "critical"
      : memory.pressureLevel === PRESSURE_LEVELS.warn
        ? "warning"
        : null;
  return (
    <ModuleCard
      {...chrome}
      title="Memory"
      accent="mem"
      headline={used}
      spokenDetails={describeStats([
        ...(memory.hasPressure ? [pressure] : []),
        ...segments,
        swap,
      ])}
      unit={
        totalBytes !== null
          ? `/ ${marketingGb(totalBytes)} GB`
          : memory.used !== null
            ? "GB"
            : undefined
      }
    >
      {memory.hasPressure && (
        <View className="flex-row items-start gap-1.5">
          {status && (
            <View className="pt-0.5">
              <StatusIcon kind={status} />
            </View>
          )}
          <View className="min-w-0 flex-1">
            <InlineBar
              {...pressure}
              fraction={ratio(memory.pressure, 100)}
              layout="wide"
            />
          </View>
        </View>
      )}
      <StackBar showLegend segments={segments} extraLegend={[swap]} />
    </ModuleCard>
  );
}
