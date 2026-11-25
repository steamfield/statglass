import type { RingArc, RingGeometry } from "@core/chart-math/ring";
import { MISSING } from "@core/format";

export interface RingGaugeInput {
  value: number | null;
  max: number;
  label: string;
  format(value: number): string;
  secondary?: string;
}

export interface RingGaugeModel {
  arcs: readonly RingArc[];
  figure: string;
  label: string;
  secondary: string | null;
  spoken: string;
}

export function ringGaugeModel(
  input: RingGaugeInput,
  _geometry: RingGeometry
): RingGaugeModel {
  return {
    arcs: [],
    figure: MISSING,
    label: input.label,
    secondary: null,
    spoken: input.label,
  };
}
