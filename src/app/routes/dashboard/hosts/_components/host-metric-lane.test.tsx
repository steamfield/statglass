import { cleanup, render } from "@testing-library/react";
import { HostMetricLane } from "./host-metric-lane";

afterEach(cleanup);

it.each([
  { values: [null, 10, 20, null], dots: 2 },
  { values: [10, 20, null, 30, 40], dots: 2 },
  { values: [null, 10, null], dots: 1 },
  { values: [null, null, null], dots: 0 },
])(
  "marks gap edges without doubling singleton dots: $values",
  ({ values, dots }) => {
    const view = render(
      <HostMetricLane
        label="CPU"
        value="—"
        values={values}
        endMs={600000}
        intervalMs={10000}
        yMax={100}
        gaps={[]}
      />
    );
    expect(view.container.querySelectorAll("[data-gap-edge]")).toHaveLength(
      dots
    );
  }
);

it("names the current reading without announcing each intervening tick", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(0);
  const lane = (value: string) => (
    <HostMetricLane
      label="CPU"
      value={value}
      values={[10, 18]}
      endMs={600000}
      intervalMs={10000}
      yMax={100}
      gaps={[]}
    />
  );
  const view = render(lane("18%"));
  try {
    expect(view.getByRole("img")).toHaveAccessibleName(
      "CPU, last 10 minutes, now 18%."
    );
    clock.mockReturnValue(1000);
    view.rerender(lane("19%"));
    expect(view.getByRole("img")).toHaveAccessibleName(
      "CPU, last 10 minutes, now 18%."
    );
    clock.mockReturnValue(10000);
    view.rerender(lane("20%"));
    expect(view.getByRole("img")).toHaveAccessibleName(
      "CPU, last 10 minutes, now 20%."
    );
    view.rerender(lane("—"));
    expect(view.getByRole("img")).toHaveAccessibleName(
      "CPU, last 10 minutes, no live reading."
    );
  } finally {
    clock.mockRestore();
  }
});
