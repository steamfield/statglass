import { ringArcs } from "@core/chart-math/ring";
import { formatTemperature, MISSING } from "@core/format";
import { describe, expect, it } from "vitest";
import {
  CORE_LOAD_FIXTURE,
  HEAT_MATRIX_FIXTURE,
  RING_GAUGE_FIXTURES,
} from "./fixtures/heat-ring";
import { heatMatrixModel, heatScaleLegendModel } from "./heat-matrix";
import { RING_GAUGE_DIMENSIONS, ringGaugeModel } from "./ring-gauge";

describe("heat matrix model", () => {
  it("models the thermal history, leaving the missing bucket untinted", () => {
    const model = heatMatrixModel(HEAT_MATRIX_FIXTURE);

    expect(model).toMatchObject({
      accent: "temp",
      columns: 4,
      firstKey: 0,
      legend: { min: "30 °C", max: "90 °C", stops: [0.08, 0.35, 0.65, 0.95] },
      spoken: "SoC thermal zones",
      spokenValue: "CPU 57 °C, GPU 49 °C",
    });
    expect(model.cells).toEqual([
      { row: 0, col: 0, alpha: expect.closeTo(0.2973, 4) },
      { row: 0, col: 1, alpha: null },
      { row: 0, col: 2, alpha: expect.closeTo(0.4457, 4) },
      { row: 0, col: 3, alpha: expect.closeTo(0.4605, 4) },
      { row: 1, col: 0, alpha: expect.closeTo(0.2677, 4) },
      { row: 1, col: 1, alpha: expect.closeTo(0.327, 4) },
      { row: 1, col: 2, alpha: expect.closeTo(0.3715, 4) },
      { row: 1, col: 3, alpha: expect.closeTo(0.3567, 4) },
    ]);
    expect(model.rows.map(({ label, current }) => [label, current])).toEqual([
      ["CPU", "57 °C"],
      ["GPU", "49 °C"],
    ]);
  });

  it("clips and pads to the window, preserves zero, and separates clusters", () => {
    const model = heatMatrixModel(CORE_LOAD_FIXTURE);
    expect(model.columns).toBe(3);
    expect(model.firstKey).toBe(4);
    expect(model.rows).toEqual([
      {
        key: "p0",
        label: "P0",
        current: "30%",
        startsGroup: false,
        values: [20, 0, 30],
      },
      {
        key: "e0",
        label: "E0",
        current: MISSING,
        startsGroup: true,
        values: [null, 12, null],
      },
    ]);
    expect(model.cells.map(({ alpha }) => alpha)).toEqual([
      expect.closeTo(0.238),
      0.06,
      expect.closeTo(0.327),
      null,
      expect.closeTo(0.1668, 4),
      null,
    ]);
    expect(model.spokenValue).toBe(`P0 30%, E0 ${MISSING}`);
  });

  it("keeps current labels while loading and produces no phantom rows when empty", () => {
    const loading = heatMatrixModel({ ...CORE_LOAD_FIXTURE, loading: true });
    expect(loading.loading).toBe(true);
    expect(loading.notice).toBe("Loading history…");
    expect(loading.rows[0]?.current).toBe("30%");
    expect(loading.cells.map(({ alpha }) => alpha)).toEqual(
      Array(6).fill(null)
    );

    const empty = heatMatrixModel({ ...HEAT_MATRIX_FIXTURE, rows: [] });
    expect(empty.rows).toEqual([]);
    expect(empty.cells).toEqual([]);
    expect(empty.notice).toBe("No samples in this range");
    expect(empty.spokenValue).toBe(empty.notice);
  });

  it("formats readings and legend ends in Fahrenheit with the supplied formatter", () => {
    const model = heatMatrixModel({
      ...HEAT_MATRIX_FIXTURE,
      format: (value) => formatTemperature(value, { units: "F" }),
    });
    expect(model.legend).toMatchObject({ min: "86 °F", max: "194 °F" });
    expect(model.rows.map(({ current }) => current)).toEqual([
      "135 °F",
      "120 °F",
    ]);
    expect(model.spokenValue).toBe("CPU 135 °F, GPU 120 °F");
    expect(model.cells).toEqual(heatMatrixModel(HEAT_MATRIX_FIXTURE).cells);
  });

  it("preserves a standalone legend's explicit labels and swatches", () => {
    expect(
      heatScaleLegendModel({
        minLabel: "0%",
        maxLabel: "80%+",
        stops: [0.06, 0.95],
      })
    ).toEqual({ min: "0%", max: "80%+", stops: [0.06, 0.95] });
  });
});

describe("ring gauge model", () => {
  it("models the temperature ring and its spoken value", () => {
    const fixture = RING_GAUGE_FIXTURES[0];
    if (!fixture) throw new Error("Missing temperature fixture");
    const model = ringGaugeModel(fixture.input, fixture.geometry);
    expect(model).toMatchObject({
      radius: 38,
      strokeWidth: 7,
      accent: "temp",
      figure: "57 °C",
      label: "CPU temperature",
      secondary: null,
      spoken: "CPU temperature",
      spokenValue: "57 °C",
      arcs: [{ length: 151.2, angle: 0, step: 1, lineCap: "round" }],
    });
    expect(model.arcs[0]?.offset).toBeCloseTo(87.56);
  });

  it("places the power ring's second segment after the first in the second ramp step", () => {
    const fixture = RING_GAUGE_FIXTURES[1];
    if (!fixture) throw new Error("Missing power fixture");
    const model = ringGaugeModel(fixture.input, fixture.geometry);
    expect(model).toMatchObject({
      radius: 48,
      strokeWidth: 8,
      accent: "power",
      figure: "14.8 W",
      label: "System power",
      secondary: "AC power",
      spoken: "System power",
      spokenValue: "14.8 W, AC power",
      arcs: [
        { length: 148.8, angle: 0, step: 1, lineCap: "round" },
        {
          length: 60.3,
          angle: expect.closeTo(177.6, 1),
          step: 2,
          lineCap: "round",
        },
      ],
    });
  });

  it("leaves missing or zero arcs invisible and clamps both segments to one turn", () => {
    const dimensions = RING_GAUGE_DIMENSIONS[88];
    const data = { value: "80%", label: "Load", accent: "cpu" } as const;
    const missing = ringGaugeModel(
      { ...data, fractions: [null, 0] },
      dimensions
    );
    expect(missing.arcs).toMatchObject([
      { length: 0, angle: 0, lineCap: "butt" },
      { length: 0, angle: 0, lineCap: "butt" },
    ]);
    const full = ringGaugeModel(
      { ...data, fractions: [0.8, 0.7, 0.1] },
      dimensions
    );
    expect(full.arcs).toHaveLength(2);
    expect(full.arcs.reduce((total, arc) => total + arc.length, 0)).toBeCloseTo(
      full.circumference,
      1
    );
  });

  it("announces a missing reading and leaves its track visible", () => {
    const model = ringGaugeModel(
      {
        value: null,
        max: 90,
        label: "CPU temperature",
        format: formatTemperature,
      },
      ringArcs(38, [0])
    );
    expect(model.spokenValue).toBe(MISSING);
    expect(model.figure).toBe(MISSING);
    expect(model.arcs).toMatchObject([{ length: 0, lineCap: "butt" }]);
  });
});
