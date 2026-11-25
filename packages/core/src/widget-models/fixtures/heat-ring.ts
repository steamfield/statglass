import { formatPercent, formatTemperature, formatWatts } from "@core/format";
import type { HeatMatrixInput } from "@core/widget-models/heat-matrix";
import {
  RING_GAUGE_DIMENSIONS,
  type RingGaugeInput,
} from "@core/widget-models/ring-gauge";

export const HEAT_MATRIX_FIXTURE: HeatMatrixInput = {
  domain: [30, 90],
  format: formatTemperature,
  accent: "temp",
  ariaLabel: "SoC thermal zones",
  rows: [
    { key: "cpu", label: "CPU", current: 57, values: [46, null, 56, 57] },
    { key: "gpu", label: "GPU", current: 49, values: [44, 48, 51, 50] },
  ],
};

export const CORE_LOAD_FIXTURE: HeatMatrixInput = {
  domain: [0, 100],
  format: formatPercent,
  accent: "cpu",
  ariaLabel: "Per-core load",
  timeline: { bucketMs: 10_000, windowMs: 30_000, endMs: 60_000 },
  rows: [
    {
      key: "p0",
      label: "P0",
      group: "P",
      current: 30,
      values: [100, 20, 0, 30],
    },
    { key: "e0", label: "E0", group: "E", current: null, values: [12, null] },
  ],
};

export const RING_GAUGE_FIXTURES: readonly {
  input: RingGaugeInput;
  size: 88 | 112;
  geometry: (typeof RING_GAUGE_DIMENSIONS)[88 | 112];
}[] = [
  {
    input: {
      value: 57,
      max: 90,
      label: "CPU temperature",
      format: formatTemperature,
      accent: "temp",
    },
    geometry: RING_GAUGE_DIMENSIONS[88],
    size: 88,
  },
  {
    input: {
      value: formatWatts(14.8),
      fractions: [14.8 / 30, 0.2],
      label: "System power",
      secondary: "AC power",
      accent: "power",
    },
    geometry: RING_GAUGE_DIMENSIONS[112],
    size: 112,
  },
];
