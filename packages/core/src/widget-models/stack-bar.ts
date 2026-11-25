/**
 * The stack-bar model: the composition bar's data contract (memory, power,
 * frequency residency) and the segments, legend rows and accessible name
 * both apps draw from it.
 */
import { clamp01 } from "@core/chart-math";
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

function segmentColor(
  segment: StackBarSegment,
  accent: Accent | undefined
): ColorRef {
  if (segment.color !== undefined) return { kind: "css", value: segment.color };
  const { step } = segment;
  if (step === "track" || step === "none") {
    // A track token with track: false reserves an unpainted segment.
    return { kind: "token", name: "track" };
  }
  const scope = accent === undefined ? {} : { accent };
  return step === "hatch"
    ? { kind: "hatch", ...scope }
    : { kind: "accent", step, ink: false, ...scope };
}

/** The bar's segments and legend. */
export function stackBarModel(data: StackBarData): StackBarModel {
  const segments: StackBarModel["segments"][number][] = [];
  const legend: StackBarModel["legend"][number][] | null = data.showLegend
    ? []
    : null;
  const labels: string[] | null = data.ariaLabel === undefined ? [] : null;
  let empty = true;

  for (const segment of data.segments) {
    const { key, label, value, step, fraction } = segment;
    legend?.push({ key, label, value, swatch: step });
    labels?.push(`${label} ${value}`);
    if (fraction === null) continue;
    empty = false;
    const grow = clamp01(fraction);
    if (grow > 0) {
      segments.push({
        key,
        grow,
        color: segmentColor(segment, data.accent),
        track: step === "track",
      });
    }
  }

  if (legend) {
    data.extraLegend?.forEach(({ label, value }, index) => {
      legend.push({ key: `extra-${index}`, label, value, swatch: "none" });
    });
  }
  return {
    ariaLabel: data.ariaLabel ?? labels?.join(", ") ?? "",
    empty,
    segments,
    legend: legend ?? NO_LEGEND,
  };
}

const NO_LEGEND: StackBarModel["legend"] = [];
