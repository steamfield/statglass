import { act, render, renderHook, screen } from "@testing-library/react";
import {
  ChartTooltipHead,
  ChartTooltipShell,
  fillTooltip,
  tooltipBeside,
  tooltipSide,
} from "./chart-tooltip";
import { paintCrosshairs, plotLeft } from "./crosshair-line";
import { useChartCursor } from "./use-chart-cursor";

/** A `tooltipBeside` length in px, for a positioned parent `parent` px wide. */
function resolve(css: string, parent: number): number {
  const js = css
    .replaceAll("calc(", "(")
    .replaceAll("max(", "Math.max(")
    .replaceAll("min(", "Math.min(")
    .replaceAll("100%", String(parent))
    .replaceAll("px", "");
  return Number(new Function(`return ${js}`)());
}

describe("tooltip placement", () => {
  it("flips at the middle of the plot", () => {
    expect(tooltipSide(0.2)).toBe("right");
    expect(tooltipSide(0.5)).toBe("right");
    expect(tooltipSide(0.51)).toBe("left");
  });

  it("sits beside the crosshair and clears the side it does not use", () => {
    expect(tooltipBeside(0.25, 200, 96)).toEqual({
      width: "200px",
      left: "max(96px, min(96px + (100% - 96px) * 0.25 + 12px, 100% - 200px))",
      right: "",
    });
    expect(tooltipBeside(0.75, 200)).toEqual({
      width: "200px",
      left: "",
      right: "max(0px, min((100% - 0px) * 0.25 + 12px, (100% - 0px) - 200px))",
    });
  });

  it("stays inside a plot too narrow for it beside the crosshair", () => {
    // A 400 px parent with a 96 px label column, so a 304 px plot. Unclamped,
    // a 276 px tooltip right of a crosshair 40% in would end at 505.6 px.
    const PARENT = 400;
    for (const f of [0.1, 0.4, 0.5, 0.6, 0.9]) {
      const { left, right } = tooltipBeside(f, 276, 96);
      const start = left
        ? resolve(left, PARENT)
        : PARENT - resolve(right, PARENT) - 276;
      expect(start, `at ${f}`).toBeGreaterThanOrEqual(96);
      expect(start + 276, `at ${f}`).toBeLessThanOrEqual(PARENT);
    }
  });
});

describe("imperative fill", () => {
  it("writes a named slot and the crosshair, without React", () => {
    const { container } = render(
      <>
        <ChartTooltipShell>
          <ChartTooltipHead />
        </ChartTooltipShell>
        <div data-crosshair="paint" hidden />
      </>
    );
    fillTooltip(container, "title", "14:02:00–14:02:10");
    expect(screen.getByRole("tooltip")).toHaveTextContent("14:02:00–14:02:10");
    const line = container.querySelector<HTMLElement>("[data-crosshair]");
    paintCrosshairs(container, plotLeft(0.5, 96));
    expect(line).toBeVisible();
    paintCrosshairs(container, null);
    expect(line).not.toBeVisible();
  });
});

describe("useChartCursor", () => {
  it("snaps the hovered time to the nearest plotted one, else rests", () => {
    const initialProps: { rest: number | null } = { rest: null };
    const { result, rerender } = renderHook(
      ({ rest }) => useChartCursor([0, 10, 30], rest),
      { initialProps }
    );
    expect(result.current.cursor).toBeNull();
    act(() => result.current.setHoverTime(22));
    expect(result.current.cursor).toBe(30);
    act(() => result.current.setHoverTime(null));
    rerender({ rest: 9 });
    expect(result.current.cursor).toBe(10);
  });
});
