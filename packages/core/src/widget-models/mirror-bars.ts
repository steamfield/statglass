/**
 * The mirror-bars model: up above a baseline and down below it, one slot per
 * interval, with a missing sample as an empty slot rather than a zero bar.
 */
import type { Accent, ColorRef } from "@core/widget-models/tokens";

/** Data contract for the mirrored bars (network, disk I/O), shared by both apps. */
export interface MirrorBarsData {
  /** History for this window is still arriving: draw the frame and the loading mark, no data. */
  loading?: boolean;
  /** Upload (or read) per interval, drawn above the baseline. `null` is a gap. */
  up: readonly (number | null)[];
  /** Download (or write), drawn below. Same length as `up`. */
  down: readonly (number | null)[];
  intervalMs: number;
  /** Timestamp of the last bar; when it advances by one interval the bars slide. */
  tEndMs?: number | undefined;
  accent: Accent;
  ariaLabel: string;
  /**
   * Scale ceilings per side. The owner holds them steady across ticks, so
   * the bars never rescale every second.
   */
  upMax: number;
  downMax: number;
  /** Heights in px of the two halves (18 above, 30 below). */
  upHeight?: number;
  downHeight?: number;
}

/** Bar heights in px per slot; `null` is an empty slot. */
export interface MirrorBarsModel {
  slots: number;
  up: readonly (number | null)[];
  down: readonly (number | null)[];
  upColor: ColorRef;
  downColor: ColorRef;
  ariaLabel: string;
}

/**
 * The bars' heights and colors.
 * @throws {Error} until the bar lane implements it
 */
export function mirrorBarsModel(_data: MirrorBarsData): MirrorBarsModel {
  throw new Error("not implemented");
}
