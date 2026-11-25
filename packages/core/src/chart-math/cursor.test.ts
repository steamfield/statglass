import { indexAt, lastAtOrBefore, nearestTime } from "./cursor";

describe("indexAt", () => {
  it("maps a fraction of the plot to its slot", () => {
    expect(indexAt(0, 4)).toBe(0);
    expect(indexAt(0.24, 4)).toBe(0);
    expect(indexAt(0.25, 4)).toBe(1);
    expect(indexAt(0.999, 4)).toBe(3);
  });

  it("is null off the plot, at the right edge, or with no slots", () => {
    expect(indexAt(-0.01, 4)).toBeNull();
    expect(indexAt(1, 4)).toBeNull();
    expect(indexAt(Number.NaN, 4)).toBeNull();
    expect(indexAt(0.5, 0)).toBeNull();
  });
});

describe("lastAtOrBefore", () => {
  const items = [{ t: 10 }, { t: 20 }, { t: 40 }];
  const start = (i: { t: number }) => i.t;

  it("finds the last item starting at or before the time", () => {
    expect(lastAtOrBefore(items, 10, start)).toBe(0);
    expect(lastAtOrBefore(items, 39, start)).toBe(1);
    expect(lastAtOrBefore(items, 40, start)).toBe(2);
    expect(lastAtOrBefore(items, 1000, start)).toBe(2);
  });

  it("is -1 before the first item or when there are none", () => {
    expect(lastAtOrBefore(items, 9, start)).toBe(-1);
    expect(lastAtOrBefore([], 9, start)).toBe(-1);
  });
});

describe("nearestTime", () => {
  const times = [0, 10, 30];

  it("snaps to the closest plotted time, including past either end", () => {
    expect(nearestTime(times, 4)).toBe(0);
    expect(nearestTime(times, 21)).toBe(30);
    expect(nearestTime(times, -50)).toBe(0);
    expect(nearestTime(times, 500)).toBe(30);
  });

  it("breaks a tie toward the later time", () => {
    expect(nearestTime(times, 5)).toBe(10);
    expect(nearestTime(times, 20)).toBe(30);
  });

  it("is null with nothing plotted", () => {
    expect(nearestTime([], 5)).toBeNull();
  });
});
