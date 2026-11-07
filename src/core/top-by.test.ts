import { topBy } from "@core/top-by";
import { describe, expect, it } from "vitest";

describe("topBy", () => {
  const rows = [
    { id: "a", v: 3 },
    { id: "b", v: null },
    { id: "c", v: 9 },
    { id: "d", v: 0 },
    { id: "e", v: 5 },
  ];

  it("ranks highest first and keeps n", () => {
    expect(topBy(rows, (r) => r.v, 2)).toEqual([
      { row: rows[2], value: 9 },
      { row: rows[4], value: 5 },
    ]);
  });

  it("drops gaps instead of ranking them as zero", () => {
    const ids = topBy(rows, (r) => r.v, 10).map((r) => r.row.id);
    expect(ids).toEqual(["c", "e", "a", "d"]);
  });

  it("is empty when every value is a gap", () => {
    expect(topBy([{ v: null }], (r) => r.v, 3)).toEqual([]);
  });
});
