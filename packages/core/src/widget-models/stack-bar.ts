/**
 * The stack-bar model: the composition bar's data contract (memory, power,
 * frequency residency) and the segments, legend rows and accessible name
 * both apps draw from it.
 */
import type { Accent, ColorRef, SwatchStep } from "@core/widget-models/tokens";

/** One segment of a {@link StackBarData}. */
export interface StackBarSegment {
  key: string;
  label: string;
  /** Formatted value for the legend and the accessible name ("3.9 GB"). */
  value: string;
  /**
   * Share of the whole bar. Segments are laid out in order. `null` is a
   * missing measurement: the segment is left out of the bar (its legend row
   * shows the missing value), and a bar with nothing measured is an empty
   * track.
   */
  fraction: number | null;
  /** `track` draws the remainder (free memory, rest of system power). */
  step: SwatchStep;
  /** A color in place of the ramp step (frequency residency states). */
  color?: string;
}

/** Data contract for the composition bar, shared by both apps. */
export interface StackBarData {
  segments: StackBarSegment[];
  /** Defaults to the accent in scope (the card's accent). */
  accent?: Accent;
  showLegend?: boolean;
  legendColumns?: "inline" | 1 | 2;
  /** Extra legend rows with no segment (popover memory "Swap"). */
  extraLegend?: { label: string; value: string }[];
  /** Overrides the generated accessible name. */
  ariaLabel?: string;
}

/** The bar's drawn segments, legend rows and accessible name. */
export interface StackBarModel {
  ariaLabel: string;
  empty: boolean;
  segments: readonly {
    key: string;
    grow: number;
    color: ColorRef;
    track: boolean;
  }[];
  legend: readonly {
    key: string;
    label: string;
    value: string;
    swatch: SwatchStep;
  }[];
}

/**
 * The bar's segments and legend.
 * @throws {Error} until the bar lane implements it
 */
export function stackBarModel(_data: StackBarData): StackBarModel {
  throw new Error("not implemented");
}
