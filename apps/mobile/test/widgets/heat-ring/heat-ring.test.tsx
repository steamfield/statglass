import { formatTemperature } from "@core/format";
import {
  CORE_LOAD_FIXTURE,
  HEAT_MATRIX_FIXTURE,
  RING_GAUGE_FIXTURES,
} from "@core/widget-models/fixtures/heat-ring";
import { heatMatrixModel } from "@core/widget-models/heat-matrix";
import {
  RING_GAUGE_DIMENSIONS,
  ringGaugeModel,
} from "@core/widget-models/ring-gauge";
import { expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { screen } from "@testing-library/react-native";
import * as ReactNative from "react-native";
import { HeatMatrix } from "@/widgets/heat-matrix";
import { RingGauge } from "@/widgets/ring-gauge";

test("shows the thermal matrix readings and legend, and announces the current values", async () => {
  const model = heatMatrixModel(HEAT_MATRIX_FIXTURE);
  await renderWithProviders(<HeatMatrix model={model} height={80} />);

  expect(
    screen.getByRole("image", { name: model.spoken })
  ).toHaveAccessibilityValue({
    text: model.spokenValue,
  });
  expect(screen.getByText(model.legend.min)).toBeOnTheScreen();
  expect(screen.getByText(model.legend.max)).toBeOnTheScreen();
  for (const row of model.rows) {
    expect(screen.getByText(row.label)).toBeOnTheScreen();
    expect(screen.getByText(row.current)).toBeOnTheScreen();
  }
});

test("paints missing buckets with hatching and a measured zero with the accent", async () => {
  const model = heatMatrixModel({
    ...CORE_LOAD_FIXTURE,
    timeline: { bucketMs: 10_000, windowMs: 20_000 },
    rows: [{ key: "p0", label: "P0", current: 0, values: [0, null] }],
  });
  await renderWithProviders(<HeatMatrix model={model} height={80} />);

  expect(screen.getByTestId("heat-gap")).toBeOnTheScreen();
  expect(screen.getByTestId("heat-gap-stripe")).toBeOnTheScreen();
  expect(screen.getByTestId("heat-cell")).toHaveProp(
    "fillOpacity",
    model.cells[0]?.alpha
  );
});

test("announces a loading matrix without drawing missing buckets", async () => {
  const model = heatMatrixModel({ ...HEAT_MATRIX_FIXTURE, loading: true });
  await renderWithProviders(<HeatMatrix model={model} height={80} />);

  expect(
    screen.getByRole("image", { name: model.spoken, busy: true })
  ).toBeOnTheScreen();
  expect(screen.getByText("Loading history…")).toBeOnTheScreen();
  expect(screen.getAllByTestId("heat-loading")).toHaveLength(
    model.cells.length
  );
  expect(screen.queryAllByTestId("heat-gap")).toHaveLength(0);
  expect(screen.queryAllByTestId("heat-cell")).toHaveLength(0);
});

test("shows a visible empty state when the matrix has no rows", async () => {
  const model = heatMatrixModel({ ...HEAT_MATRIX_FIXTURE, rows: [] });
  await renderWithProviders(<HeatMatrix model={model} height={80} />);

  expect(screen.getByText("No samples in this range")).toBeOnTheScreen();
  expect(
    screen.getByRole("image", { name: model.spoken })
  ).toHaveAccessibilityValue({
    text: "No samples in this range",
  });
});

test.each(RING_GAUGE_FIXTURES)(
  "shows and announces the $input.label gauge",
  async ({ input, geometry, size }) => {
    const model = ringGaugeModel(input, geometry);
    await renderWithProviders(<RingGauge model={model} size={size} />);

    expect(
      screen.getByRole("image", { name: model.spoken })
    ).toHaveAccessibilityValue({
      text: model.spokenValue,
    });
    expect(screen.getByText(model.figure)).toBeOnTheScreen();
    expect(screen.getByText(model.label)).toBeOnTheScreen();
    expect(screen.getAllByTestId("ring-arc")).toHaveLength(model.arcs.length);
    if (model.secondary)
      expect(screen.getByText(model.secondary)).toBeOnTheScreen();
  }
);

test("shows and announces a missing ring reading", async () => {
  const model = ringGaugeModel(
    {
      value: null,
      max: 90,
      label: "CPU temperature",
      format: formatTemperature,
    },
    RING_GAUGE_DIMENSIONS[88]
  );
  await renderWithProviders(<RingGauge model={model} size={88} />);
  expect(screen.getByText(model.figure)).toBeOnTheScreen();
  expect(screen.getByTestId("ring-track")).toBeOnTheScreen();
  expect(screen.queryByTestId("ring-arc")).toBeNull();
  expect(
    screen.getByRole("image", { name: model.spoken })
  ).toHaveAccessibilityValue({
    text: model.spokenValue,
  });
});

test("gives a ring's caption more room at accessibility text sizes", async () => {
  jest.spyOn(ReactNative, "useWindowDimensions").mockReturnValue({
    width: 402,
    height: 874,
    fontScale: 1.65,
    scale: 3,
  });
  const model = ringGaugeModel(
    { value: 57, max: 90, label: "CPU temperature", format: formatTemperature },
    RING_GAUGE_DIMENSIONS[88]
  );
  await renderWithProviders(<RingGauge model={model} size={88} />);

  const ring = screen.getByRole("image", { name: model.spoken });
  const { width } = ReactNative.StyleSheet.flatten(ring.props.style);
  expect(width).toBeGreaterThan(88);
  expect(screen.getByText(model.figure)).toBeOnTheScreen();
  expect(screen.getByText(model.label)).toBeOnTheScreen();
});
