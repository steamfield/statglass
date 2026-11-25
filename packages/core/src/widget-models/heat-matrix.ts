export interface HeatMatrixInput {
  rows: readonly {
    key: string;
    label: string;
    values: readonly (number | null)[];
  }[];
  domain: readonly [number, number];
  format(value: number): string;
}

export interface HeatMatrixModel {
  cells: readonly { row: number; col: number; alpha: number | null }[];
  rows: readonly { key: string; label: string; current: string }[];
  legend: { min: string; max: string };
  spoken: string;
}

export function heatMatrixModel(_input: HeatMatrixInput): HeatMatrixModel {
  return {
    cells: [],
    rows: [],
    legend: { min: "", max: "" },
    spoken: "Heat matrix",
  };
}
