import { describe, expect, it } from "vitest";
import { chartLabel, shouldRefreshFigures } from "./chart-label";

describe("chartLabel", () => {
  it("uses the desktop's wording for a live reading", () => {
    expect(chartLabel({ subject: "CPU", spanMs: 60_000, now: "now 17%" })).toBe(
      "CPU, last 60 seconds, now 17%."
    );
  });

  it("can omit the reading and include the range selection instruction", () => {
    expect(
      chartLabel({
        subject: "Network: upload above the line, download below",
        spanMs: 48_000,
        now: null,
        brushable: true,
      })
    ).toBe(
      "Network: upload above the line, download below, last 48 seconds. Drag to select a range."
    );
  });
});

describe("shouldRefreshFigures", () => {
  const previous = { edgeMs: 18_000, bucketMs: 10_000 };

  it("takes the first reading immediately and holds it until the stream crosses a bucket", () => {
    expect(shouldRefreshFigures(null, previous)).toBe(true);
    expect(
      shouldRefreshFigures(previous, { ...previous, edgeMs: 19_000 })
    ).toBe(false);
    expect(
      shouldRefreshFigures(previous, { ...previous, edgeMs: 20_000 })
    ).toBe(true);
  });

  it("refreshes when the bucket width changes or the stream restarts in an earlier bucket", () => {
    expect(
      shouldRefreshFigures(
        { ...previous, edgeMs: 8_000 },
        { edgeMs: 8_000, bucketMs: 15_000 }
      )
    ).toBe(true);
    expect(shouldRefreshFigures(previous, { ...previous, edgeMs: 8_000 })).toBe(
      true
    );
  });
});
