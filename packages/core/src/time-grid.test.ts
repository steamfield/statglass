import { ceilTo, DAY_MS, floorTo, HOUR_MS } from "@core/time-grid";

describe("floorTo and ceilTo", () => {
  it("snaps to the grid line at or before and at or after", () => {
    expect(floorTo(25_000, 10_000)).toBe(20_000);
    expect(ceilTo(25_000, 10_000)).toBe(30_000);
    expect(floorTo(20_000, 10_000)).toBe(20_000);
    expect(ceilTo(20_000, 10_000)).toBe(20_000);
  });

  it("snaps negative times down, not toward zero", () => {
    expect(floorTo(-5_000, 10_000)).toBe(-10_000);
    expect(ceilTo(-5_000, 10_000)).toBe(0);
  });
});

describe("calendar-free spans", () => {
  it("snaps to hours and days of epoch time", () => {
    expect(floorTo(DAY_MS + HOUR_MS + 1, HOUR_MS)).toBe(DAY_MS + HOUR_MS);
    expect(ceilTo(DAY_MS + 1, DAY_MS)).toBe(2 * DAY_MS);
  });
});
