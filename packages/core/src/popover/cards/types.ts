import type { ByteUnits, RateUnits } from "@core/format";
import type { PowerSource } from "@core/generated/types";
import type { BatterySelection } from "@core/live-selectors";
import type { InlineBarModel } from "@core/widget-models/inline-bar";
import type { StackBarSegment as StackSegment } from "@core/widget-models/stack-bar";
import type { StatListItem as StatItemModel } from "@core/widget-models/stat-list";

export interface CardContent {
  title: string;
  headline: string | null;
  segments: readonly StackSegment[];
  items: readonly StatItemModel[];
  bars: readonly InlineBarModel[];
  /** VoiceOver details, built when the phone reads them. */
  readonly spoken: string;
}

/** Readings and display settings that arrive outside the module selector. */
export interface CardSource {
  bytes?: ByteUnits;
  rate?: RateUnits;
  totalBytes?: number | null;
  primaryIface?: string | null;
  powerSource?: PowerSource | null;
  showBattery?: boolean;
  battery?: BatterySelection | null;
  chartLabel?: string | undefined;
  compact?: boolean;
}
