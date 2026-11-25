/**
 * The mirror-bars model: up above a baseline and down below it, one slot per
 * interval, with a missing sample as an empty slot rather than a zero bar.
 */
import { clamp01 } from "@core/chart-math";
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

function heights(values: readonly (number | null)[], max: number, h: number) {
  return values.map((v) =>
    v == null || !Number.isFinite(v) || max <= 0 ? null : clamp01(v / max) * h
  );
}

/** The bars' heights and colors. */
export function mirrorBarsModel({
  up,
  down,
  upMax,
  downMax,
  upHeight = 18,
  downHeight = 30,
  accent,
  ariaLabel,
  loading,
}: MirrorBarsData): MirrorBarsModel {
  return {
    slots: Math.max(up.length, down.length, 1),
    up: loading ? [] : heights(up, upMax, upHeight),
    down: loading ? [] : heights(down, downMax, downHeight),
    upColor: { kind: "accent", accent, step: 2, ink: false },
    downColor: { kind: "accent", accent, step: 1, ink: false },
    ariaLabel,
  };
}
