/**
 * The chart-annotation model: which labelled markers fall inside a chart's
 * window, and the row and position the shared marker layout gives each.
 */

/** A labelled marker on a chart (power spikes, D-083); JSON-serializable. */
export interface ChartAnnotationData {
  /** When the annotated moment happened (ms epoch); the chart positions it. */
  tsMs: number;
  /** "ANE 1.4 W · Photos face analysis". */
  label: string;
  /**
   * `marker`: a 20 px vertical rule then the label (power chart).
   * `pill`: a bordered label on the card surface (battery chart).
   */
  variant?: "marker" | "pill";
  /**
   * `end` puts the marker after the label, for a box anchored by its right
   * edge so a label near the plot's right edge doesn't run past it.
   */
  align?: "start" | "end";
}

/** One placed marker: its x as a fraction of the plot and its stacking row. */
export interface AnnotationModel {
  key: string;
  xFrac: number;
  row: number;
  label: string;
  tone: string;
}

/**
 * The annotations inside the window ending at `tEndMs`, laid out through
 * `layoutMarkers` for a plot `widthPx` wide; markers outside it are dropped.
 * @throws {Error} until the chart lane implements it
 */
export function annotationsModel(
  _annotations: readonly ChartAnnotationData[] | undefined,
  _tEndMs: number,
  _windowMs: number,
  _widthPx: number
): AnnotationModel[] {
  throw new Error("not implemented");
}
