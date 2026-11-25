/**
 * The meter-track model: a rounded track with a fill scaled from the left,
 * and the empty track that stands for a missing measurement.
 */
import type { ColorRef } from "@core/widget-models/tokens";

/**
 * Data contract for the bar meter, shared by both apps. The desktop widget
 * adds its own presentation props (a CSS fill, height and classes).
 */
export interface MeterTrackData {
  /**
   * Fill as a fraction of the track, clamped to 0..1. `null` is a missing
   * measurement: the track is drawn empty, never a zero-width fill that
   * reads as a real 0.
   */
  fraction: number | null;
}

/** The fill to draw; `fill: null` is an empty track. */
export interface MeterTrackModel {
  fill: number | null;
  color: ColorRef;
}

/**
 * The meter's fill.
 * @throws {Error} until the bar lane implements it
 */
export function meterTrackModel(_data: MeterTrackData): MeterTrackModel {
  throw new Error("not implemented");
}
