import {
  cssPercent,
  formatBytes,
  formatPercentPoints,
  formatSignedDelta,
} from "@core/format";

/** The shape `historicalDelta` and `laneComparison` build by hand today. */
const pp = (difference: number) =>
  formatSignedDelta(difference, formatPercentPoints);

describe("formatSignedDelta", () => {
  it("signs a difference with + or a typographic minus", () => {
    expect(pp(3.44)).toBe("+3.4 pp");
    expect(pp(-12.06)).toBe("−12.1 pp");
    expect(formatSignedDelta(-2e9, (b) => formatBytes(b))).toBe("−2.0 GB");
  });

  it("leaves no change unsigned, but a change too small to show keeps its sign", () => {
    expect(pp(0)).toBe("0.0 pp");
    expect(pp(0.01)).toBe("+0.0 pp");
  });
});

describe("formatPercentPoints", () => {
  it("is one decimal with a pp unit", () => {
    expect(formatPercentPoints(3.44)).toBe("3.4 pp");
    expect(formatPercentPoints(0)).toBe("0.0 pp");
  });
});

describe("cssPercent", () => {
  it("turns a fraction into a CSS percentage, three decimals by default", () => {
    expect(cssPercent(0.125)).toBe("12.500%");
    expect(cssPercent(1)).toBe("100.000%");
    expect(cssPercent(1 / 3, 2)).toBe("33.33%");
    expect(cssPercent(0.5, 0)).toBe("50%");
  });
});
