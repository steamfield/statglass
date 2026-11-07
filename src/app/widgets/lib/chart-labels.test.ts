import { ceilingAxis, PERCENT_Y_TICKS } from "./chart-labels";

describe("ceilingAxis", () => {
  it("puts gridlines at half and full height", () => {
    expect(ceilingAxis(40)).toEqual({ gridlines: [20, 40] });
  });

  it("labels the ceiling with its unit and the half bare", () => {
    expect(ceilingAxis(5, "5W")).toEqual({
      gridlines: [2.5, 5],
      yTicks: [
        { value: 5, label: "5W" },
        { value: 2.5, label: "2.5" },
      ],
    });
  });

  it("formats every tick with a format function", () => {
    expect(ceilingAxis(40, (v) => `${v}%`).yTicks).toEqual([
      { value: 40, label: "40%" },
      { value: 20, label: "20%" },
    ]);
  });

  it("adds a bare zero tick at the baseline on request", () => {
    expect(ceilingAxis(40, (v) => `${v}%`, { zero: true })).toEqual({
      gridlines: [20, 40],
      yTicks: [
        { value: 40, label: "40%" },
        { value: 20, label: "20%" },
        { value: 0, label: "0" },
      ],
    });
  });
});

describe("PERCENT_Y_TICKS", () => {
  it("reads top down without the unit", () => {
    expect(PERCENT_Y_TICKS.map((t) => t.label)).toEqual([
      "100",
      "75",
      "50",
      "25",
    ]);
  });
});
