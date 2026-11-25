/**
 * The gap-band model: which labelled no-data spans overlap a chart's window,
 * and where each sits as a fraction of the plot width.
 */

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

/**
 * The gaps that overlap `fromMs..toMs`, clipped to it; spans outside the
 * window are dropped.
 * @throws {Error} until the chart lane implements it
 */
export function gapBandsModel(
  _gaps: readonly GapSpan[],
  _fromMs: number,
  _toMs: number
): GapBandModel[] {
  throw new Error("not implemented");
}
