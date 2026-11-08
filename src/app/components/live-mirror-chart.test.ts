import { brushBucketMs } from "@core/brush";
import { CHART_WINDOW_MS, CHART_WINDOWS } from "@core/live-window";
import { mirrorBuckets } from "./live-mirror-chart";

describe("mirror chart buckets (D-091)", () => {
  it("30m at 1 s: 15 s bars, 30 s when brushable", () => {
    expect(mirrorBuckets(1_800_000, 1000)).toEqual({
      bucketMs: 15_000,
      count: 120,
    });
    expect(brushBucketMs(15_000, 1000)).toBe(30_000);
  });

  it("a narrow card's cap keeps 15m at 1 s to 40 bars", () => {
    expect(mirrorBuckets(900_000, 1000, false, 40)).toEqual({
      bucketMs: 23_000,
      count: 39,
    });
  });

  it.each([250, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000])(
    "no window draws more than 120 bars at %i ms sampling",
    (intervalMs) => {
      for (const w of CHART_WINDOWS) {
        const plain = mirrorBuckets(CHART_WINDOW_MS[w], intervalMs);
        expect(plain.count).toBeLessThanOrEqual(120);
        // Brushable bars are never narrower, so never more of them.
        expect(
          brushBucketMs(plain.bucketMs, intervalMs)
        ).toBeGreaterThanOrEqual(plain.bucketMs);
      }
    }
  );
});
