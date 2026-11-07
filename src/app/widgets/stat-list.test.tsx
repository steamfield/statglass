import { render, screen } from "@testing-library/react";
import { expectJsonRoundTrip } from "@tests/widget-json";
import {
  BATTERY_STAT_GRID,
  BATTERY_STAT_STRIP,
  CPU_STAT_STRIP,
  GPU_STAT_GRID,
  POWER_STAT_GRID,
} from "./lib/sample-props";
import { StatList } from "./stat-list";

describe("StatList", () => {
  it("round-trips its props through JSON", () => {
    for (const props of [
      CPU_STAT_STRIP,
      BATTERY_STAT_STRIP,
      GPU_STAT_GRID,
      POWER_STAT_GRID,
      BATTERY_STAT_GRID,
    ])
      expectJsonRoundTrip(StatList, props);
  });

  it("renders the strip's hero and secondary figures", () => {
    render(<StatList {...CPU_STAT_STRIP} />);
    expect(screen.getByText("18%")).toBeInTheDocument();
    expect(screen.getByText("Load avg").nextElementSibling).toHaveTextContent(
      "3.42 2.98 2.71"
    );
  });

  it("lays the grid out in one column per item, each label with its value", () => {
    const { container } = render(<StatList {...GPU_STAT_GRID} />);
    expect(container.querySelector("dl")).toHaveStyle({
      gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    });
    expect(screen.getByText("Power").nextElementSibling).toHaveTextContent(
      "3.1 W"
    );
  });

  it("puts the grid's value classes on every value cell", () => {
    render(
      <StatList
        layout="grid"
        items={GPU_STAT_GRID.items}
        valueClassName="min-w-10"
      />
    );
    for (const label of ["Freq", "Power", "Cores"])
      expect(screen.getByText(label).nextElementSibling).toHaveClass(
        "min-w-10"
      );
  });
});
