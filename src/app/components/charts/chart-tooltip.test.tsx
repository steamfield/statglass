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

describe("tooltip placement", () => {
  it("flips at the middle of the plot", () => {
    expect(tooltipSide(0.2)).toBe("right");
    expect(tooltipSide(0.5)).toBe("right");
    expect(tooltipSide(0.51)).toBe("left");
  });

  it("sits beside the crosshair and clears the side it does not use", () => {
    expect(tooltipBeside(0.25, 96)).toEqual({
      left: "calc(96px + (100% - 96px) * 0.25 + 12px)",
      right: "",
    });
    expect(tooltipBeside(0.75)).toEqual({
      left: "",
      right: "calc((100% - 0px) * 0.25 + 12px)",
    });
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
