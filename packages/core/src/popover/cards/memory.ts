import { ratio } from "@core/chart-math";
import {
  bytesParts,
  formatBytes,
  formatMarketingMemory,
  formatPercent,
  MISSING,
} from "@core/format";
import { METRIC_CODES } from "@core/generated/types";
import type { MemorySelection } from "@core/live-selectors";
import {
  type InlineBarModel,
  inlineBarModel,
} from "@core/widget-models/inline-bar";
import type { StackBarSegment } from "@core/widget-models/stack-bar";
import { describeStats } from "@core/widget-models/stat-list";
import type { CardContent, CardSource } from "./types";

const PRESSURE_CODES = METRIC_CODES["mem.pressure_level"];
const PRESSURE_LABEL = "Pressure";

function pressureLevel(code: number | null) {
  switch (code) {
    case PRESSURE_CODES.critical:
      return "critical";
    case PRESSURE_CODES.warn:
      return "warn";
    case PRESSURE_CODES.normal:
      return "normal";
    default:
      return null;
  }
}

export function memoryCard(
  sel: MemorySelection,
  { bytes = "GB", totalBytes = null }: CardSource
): CardContent & {
  headline: string;
  capacity: string | null;
  usedUnit: string | undefined;
  usedFraction: number | null;
  bars: readonly [InlineBarModel];
  hasPressure: boolean;
  pressureStatus: "critical" | "warning" | null;
  compactPressure: string | null;
  fullLegend: { segments: StackBarSegment[]; pressure: InlineBarModel };
} {
  const segment = (
    key: string,
    label: string,
    value: number | null,
    step: StackBarSegment["step"]
  ): StackBarSegment => ({
    key,
    label,
    value: formatBytes(value),
    fraction: ratio(value, totalBytes),
    step,
  });
  const cached = segment("cached", "Cached files", sel.cached, 4);
  const free = segment("free", "Free", sel.free, "track");
  // The desktop keeps the full composition legend even when its readings are absent.
  const compositionSegments = [
    segment("wired", "Wired", sel.wired, 1),
    segment("app", "App", sel.app, 2),
    segment("compressed", "Compressed", sel.compressed, "hatch"),
    cached,
    free,
  ];
  const segments = sel.composition
    ? compositionSegments
    : [segment("used", "Used", sel.used, 1), cached, free];
  const items = [{ label: "Swap", value: formatBytes(sel.swapUsed) }];
  const level = pressureLevel(sel.pressureLevel);
  const pressureSummary = `${PRESSURE_LABEL} · ${level ?? "normal"}`;
  const pressure = inlineBarModel({
    label: level === null ? PRESSURE_LABEL : pressureSummary,
    value: formatPercent(sel.pressure),
    fraction: ratio(sel.pressure, 100),
    layout: "wide",
  });
  const spokenPressure =
    pressure.value === MISSING
      ? { label: PRESSURE_LABEL, value: MISSING }
      : pressure;
  return {
    title: "Memory",
    headline:
      sel.used === null
        ? MISSING
        : bytesParts(sel.used, { units: bytes, unit: bytes, decimals: 1 })
            .value,
    capacity:
      totalBytes === null ? null : `/ ${formatMarketingMemory(totalBytes)}`,
    usedUnit: sel.used === null ? undefined : bytes,
    usedFraction: ratio(sel.used, totalBytes),
    hasPressure: sel.hasPressure,
    pressureStatus:
      level === "warn" ? "warning" : level === "critical" ? "critical" : null,
    compactPressure: sel.hasPressure ? pressureSummary : null,
    fullLegend: {
      segments: compositionSegments,
      pressure:
        level === null ? { ...pressure, label: pressureSummary } : pressure,
    },
    segments,
    items,
    bars: [pressure],
    spoken: describeStats(
      sel.hasPressure
        ? [spokenPressure, ...segments, ...items]
        : [...segments, ...items]
    ),
  };
}
