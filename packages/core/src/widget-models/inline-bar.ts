/**
 * The inline-bar model: a label, a formatted value and a horizontal meter,
 * including the empty track for a missing value and no track at all where
 * the bar has no meaning.
 */
import type { MeterTrackModel } from "@core/widget-models/meter-track";
import type { Accent, RampStep } from "@core/widget-models/tokens";

/** Data contract for the label, value and bar row, shared by both apps. */
export interface InlineBarData {
  label: string;
  /** Formatted value ("3.2 GHz", "42%"). */
  value: string;
  /**
   * Fill as a fraction of the track. `null` is a missing measurement: the
   * track is drawn empty, with no fill, never a zero-width fill that reads
   * as a real 0. `"none"` means the bar has no meaning here (a Mac without
   * fans): the value text stands alone and no track is drawn.
   */
  fraction: number | null | "none";
  /** Defaults to the accent in scope (the card's accent). */
  accent?: Accent;
  rampStep?: RampStep;
  /**
   * `stacked`: field label and value over a 4 px bar (Overview, 04).
   * `row`: label, right-aligned value, bar in one grid row (popover, 14).
   * `wide`: label and value over a 6 px bar (popover memory pressure, battery).
   */
  layout?: "stacked" | "row" | "wide";
}

/** The row's strings, layout and track; `track: null` draws no track. */
export interface InlineBarModel {
  label: string;
  value: string;
  layout: "stacked" | "row" | "wide";
  track: MeterTrackModel | null;
}

/**
 * The row's strings and track.
 * @throws {Error} until the bar lane implements it
 */
export function inlineBarModel(_data: InlineBarData): InlineBarModel {
  throw new Error("not implemented");
}
