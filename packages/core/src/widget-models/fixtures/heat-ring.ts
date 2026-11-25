import { type RingGeometry, ringArcs } from "@core/chart-math/ring";
import { formatTemperature, formatWatts } from "@core/format";
import type { HeatMatrixInput } from "@core/widget-models/heat-matrix";
import type { RingGaugeInput } from "@core/widget-models/ring-gauge";

export const HEAT_MATRIX_FIXTURE: HeatMatrixInput = {
  domain: [30, 90],
  format: formatTemperature,
  rows: [
    { key: "cpu", label: "CPU", values: [46, null, 56, 57] },
    { key: "gpu", label: "GPU", values: [44, 48, 51, 50] },
  ],
};

export const RING_GAUGE_FIXTURES: readonly {
  input: RingGaugeInput;
  geometry: RingGeometry;
  size: 88 | 112;
}[] = [
  {
    input: {
      value: 57,
      max: 90,
      label: "CPU temperature",
      format: formatTemperature,
    },
    geometry: ringArcs(38, [57 / 90]),
    size: 88,
  },
  {
    input: { value: 14.8, max: 30, label: "System power", format: formatWatts },
    geometry: ringArcs(48, [14.8 / 30]),
    size: 112,
  },
];
