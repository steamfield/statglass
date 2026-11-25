import {
  type RingArc,
  type RingGeometry,
  ringArcs,
} from "@core/chart-math/ring";
import { MISSING } from "@core/format";
import type { Accent } from "./tokens";

export type RingGaugeInput = {
  label: string;
  secondary?: string;
  accent?: Accent;
} & (
  | { value: number | null; max: number; format(value: number): string }
  | { value: string; fractions: readonly (number | null)[] }
);

interface RingGaugeDimensions {
  radius: number;
  strokeWidth: number;
}

export const RING_GAUGE_DIMENSIONS = {
  88: { radius: 38, strokeWidth: 7 },
  112: { radius: 48, strokeWidth: 8 },
} satisfies Record<number, RingGaugeDimensions>;

export interface RingGaugeModel {
  arcs: readonly (RingArc & {
    step: 1 | 2;
    angle: number;
    offset: number;
    lineCap: "round" | "butt";
  })[];
  radius: number;
  strokeWidth: number;
  circumference: number;
  accent: Accent;
  figure: string;
  label: string;
  secondary: string | null;
  spoken: string;
  spokenValue: string;
}

export function ringGaugeModel(
  input: RingGaugeInput,
  geometry: RingGeometry | RingGaugeDimensions
): RingGaugeModel {
  const numeric = !("fractions" in input);
  const reading = numeric && Number.isFinite(input.value) ? input.value : null;
  const figure = numeric
    ? reading === null
      ? MISSING
      : input.format(reading)
    : input.value;
  const fractions = numeric
    ? [reading !== null && input.max > 0 ? reading / input.max : 0]
    : input.fractions;
  const dimensions = "radius" in geometry;
  const radius = dimensions
    ? geometry.radius
    : geometry.circumference / (2 * Math.PI);
  const { circumference, arcs } = ringArcs(
    radius,
    fractions.slice(0, 2).map((fraction) => fraction ?? 0)
  );
  let start = 0;
  const viewArcs = arcs.map((arc, index): RingGaugeModel["arcs"][number] => {
    const angle = circumference > 0 ? (start / circumference) * 360 : 0;
    start += arc.length;
    return {
      ...arc,
      step: index === 0 ? 1 : 2,
      angle,
      offset: circumference - arc.length,
      lineCap: arc.length > 0 ? "round" : "butt",
    };
  });
  return {
    arcs: viewArcs,
    radius,
    strokeWidth: dimensions
      ? geometry.strokeWidth
      : RING_GAUGE_DIMENSIONS[88].strokeWidth,
    circumference,
    accent: input.accent ?? "power",
    figure,
    label: input.label,
    secondary: input.secondary ?? null,
    spoken: input.label,
    spokenValue: input.secondary ? `${figure}, ${input.secondary}` : figure,
  };
}
