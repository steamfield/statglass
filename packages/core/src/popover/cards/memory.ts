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
import {
  describeStats,
  type StatListItem,
} from "@core/widget-models/stat-list";
import type { CardContent, CardSource } from "./types";

const PRESSURE_CODES = METRIC_CODES["mem.pressure_level"];
const PRESSURE_LABEL = "Pressure";
const PRESSURE_STATUS = {
  normal: null,
  warn: "warning",
  critical: "critical",
} as const;

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

function memorySegments(
  sel: MemorySelection,
  totalBytes: number | null,
  composition: boolean
): StackBarSegment[] {
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
  if (!composition) {
    return [segment("used", "Used", sel.used, 1), cached, free];
  }
  return [
    segment("wired", "Wired", sel.wired, 1),
    segment("app", "App", sel.app, 2),
    segment("compressed", "Compressed", sel.compressed, "hatch"),
    cached,
    free,
  ];
}

function pressureSummary(level: ReturnType<typeof pressureLevel>): string {
  return `${PRESSURE_LABEL} · ${level ?? "normal"}`;
}

function memoryPressure(value: number | null, label: string): InlineBarModel {
  return inlineBarModel({
    label,
    value: formatPercent(value),
    fraction: ratio(value, 100),
    layout: "wide",
  });
}

function memoryItems(sel: MemorySelection): StatListItem[] {
  return [{ label: "Swap", value: formatBytes(sel.swapUsed) }];
}

/** The complete composition legend, including rows with absent readings. */
export function memoryFullLegend(
  sel: MemorySelection,
  totalBytes: number | null
) {
  return {
    segments: memorySegments(sel, totalBytes, true),
    pressure: memoryPressure(
      sel.pressure,
      pressureSummary(pressureLevel(sel.pressureLevel))
    ),
    items: memoryItems(sel),
  };
}

function describeMemory(
  pressure: InlineBarModel | undefined,
  segments: readonly StackBarSegment[],
  items: readonly StatListItem[]
): string {
  if (!pressure) return describeStats([...segments, ...items]);
  const reading =
    pressure.value === MISSING
      ? { label: PRESSURE_LABEL, value: MISSING }
      : pressure;
  return describeStats([reading, ...segments, ...items]);
}

export function memoryCard(
  sel: MemorySelection,
  { bytes = "GB", totalBytes = null, compact = false }: CardSource
): CardContent & {
  headline: string;
  capacity: string | null;
  usedUnit: string | undefined;
  usedFraction: number | null;
  segments: StackBarSegment[];
  pressureStatus: "critical" | "warning" | null;
  compactPressure: string | null;
} {
  const segments = compact
    ? []
    : memorySegments(sel, totalBytes, sel.composition);
  const items = compact ? [] : memoryItems(sel);
  const level = pressureLevel(sel.pressureLevel);
  const summary = sel.hasPressure ? pressureSummary(level) : null;
  const bars =
    !compact && summary !== null
      ? [
          memoryPressure(
            sel.pressure,
            level === null ? PRESSURE_LABEL : summary
          ),
        ]
      : [];
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
    pressureStatus: level && PRESSURE_STATUS[level],
    compactPressure: summary,
    segments,
    items,
    bars,
    get spoken() {
      return describeMemory(bars[0], segments, items);
    },
  };
}
