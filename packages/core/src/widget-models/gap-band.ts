/**
 * The gap-band model: which labelled no-data spans overlap a chart's window,
 * and where each sits as a fraction of the plot width.
 */
import { DAY_MS } from "@core/time-grid";

/** A labelled span with no data, in ms epoch; JSON-serializable. */
export interface GapSpan {
  fromMs: number;
  toMs: number;
  /** "Asleep 11:02–11:31 · not interpolated", "Paused", "StatGlass not running". */
  label: string;
  reason?: string | undefined;
  closedDurationMs?: number | null;
  showCaption?: boolean | undefined;
}

/** One band clipped to the window, positioned in fractions of the plot width. */
export interface GapBandModel {
  key: string;
  leftFrac: number;
  widthFrac: number;
  label: string;
  paused: boolean;
}

/** The original span bounds and whether to show its caption in this window. */
export interface PlacedGapBand extends GapBandModel {
  fromMs: number;
  toMs: number;
  showCaption: boolean;
}

/** The position of a single band in a plot. */
export function gapBandPosition(
  gap: Pick<GapSpan, "fromMs" | "toMs">,
  fromMs: number,
  toMs: number
) {
  const span = Math.max(1, toMs - fromMs);
  const leftFrac = Math.max(0, (gap.fromMs - fromMs) / span);
  const rightFrac = Math.min(1, (gap.toMs - fromMs) / span);
  return { leftFrac, widthFrac: Math.max(0, rightFrac - leftFrac) };
}

/**
 * The gaps that overlap `fromMs..toMs`, clipped to it; spans outside the
 * window are dropped.
 */
export function gapBandsModel(
  gaps: readonly GapSpan[],
  fromMs: number,
  toMs: number
): PlacedGapBand[] {
  if (toMs <= fromMs) return [];
  const showCaptions = toMs - fromMs <= DAY_MS;
  const bands: PlacedGapBand[] = [];
  for (const gap of gaps) {
    if (!(gap.toMs > fromMs && gap.fromMs < toMs)) continue;
    bands.push({
      key: `${gap.fromMs}:${gap.toMs}:${gap.label}`,
      ...gapBandPosition(gap, fromMs, toMs),
      fromMs: gap.fromMs,
      toMs: gap.toMs,
      label: gap.label,
      paused: gap.reason === "paused",
      showCaption: showCaptions && gap.showCaption !== false,
    });
  }
  return bands;
}
