import { mockContainer } from "@core/mock/docker-fixtures";
import { render } from "@testing-library/react";
import { ComparisonLines } from "./comparison-lines";

const dot = (time: number, partial: boolean) => ({
  x: time,
  y: 40,
  time,
  value: 12,
  partial,
});

it("draws a covered lone bucket as the hollow gap-edge dot, a partial one filled", () => {
  const { container } = render(
    <svg aria-hidden viewBox="0 0 1000 100">
      <ComparisonLines
        plotSeries={[
          {
            container: mockContainer(0, 1_791_900_000_000),
            points: [],
            slot: 1,
            geometry: {
              runs: [],
              bands: [],
              dots: [dot(100, false), dot(500, true)],
            },
          },
        ]}
        active={null}
        onFocus={() => {}}
        plotWidth={500}
      />
    </svg>
  );
  const hollow = container.querySelectorAll("[data-gap-edge]");
  expect(hollow).toHaveLength(1);
  expect(hollow[0]?.getAttribute("cx")).toBe("100");
  expect(hollow[0]?.getAttribute("fill")).toBe("var(--color-card)");
  expect(hollow[0]?.getAttribute("stroke")).toBe("var(--color-series-1)");
  // 7 px across including the 1.5 px ring.
  expect(hollow[0]?.getAttribute("ry")).toBe("2.75");
  const filled = container.querySelectorAll("[data-partial-dot]");
  expect(filled).toHaveLength(1);
  expect(filled[0]?.getAttribute("cx")).toBe("500");
});
