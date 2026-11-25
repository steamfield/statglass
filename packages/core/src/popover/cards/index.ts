import type { PowerSource } from "../../generated/types";
import type {
  BatterySelection,
  CpuSelection,
  GpuSelection,
  MemorySelection,
  NetworkSelection,
  PowerSelection,
} from "../../live-selectors";
import type { InlineBarModel } from "../../widget-models/inline-bar";
import type { StackBarSegment as StackSegment } from "../../widget-models/stack-bar";
import type { StatListItem as StatItemModel } from "../../widget-models/stat-list";

export interface CardContent {
  title: string;
  headline: string | null;
  segments: readonly StackSegment[];
  items: readonly StatItemModel[];
  bars: readonly InlineBarModel[];
  spoken: string;
}

export interface CardSource {
  totalBytes?: number | null;
  powerSource?: PowerSource | null;
  battery?: BatterySelection | null;
}

function emptyCard(): CardContent {
  return {
    title: "",
    headline: null,
    segments: [],
    items: [],
    bars: [],
    spoken: "",
  };
}

export function cpuCard(_sel: CpuSelection, _src: CardSource): CardContent {
  return emptyCard();
}

export function memoryCard(
  _sel: MemorySelection,
  _src: CardSource
): CardContent {
  return emptyCard();
}

export function gpuCard(_sel: GpuSelection, _src: CardSource): CardContent {
  return emptyCard();
}

export function powerCard(_sel: PowerSelection, _src: CardSource): CardContent {
  return emptyCard();
}

export function networkCard(
  _sel: NetworkSelection,
  _src: CardSource
): CardContent {
  return emptyCard();
}

export function batteryCard(
  _sel: BatterySelection,
  _src: CardSource
): CardContent {
  return emptyCard();
}
