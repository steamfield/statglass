import { historyGrid } from "@core/history-grid";
import { expect, test } from "@jest/globals";
import { stitchCardWindow } from "@/data/card-window";

const metric = "cpu.total";
const history = historyGrid(
  {
    tier: "live1s",
    bucket_ms: 20,
    gaps: [],
    series: [
      {
        key: { metric, labels: [] },
        hold_ms: 20,
        points: [
          { t: 0, avg: 12, min: 12, max: 12 },
          { t: 40, avg: 0, min: 0, max: 0 },
          { t: 60, avg: 90, min: 90, max: 90 },
        ],
      },
    ],
  },
  [metric],
  0,
  80
);

test("looks up older midpoints on the history grid and preserves missing and zero buckets", () => {
  const ring = [null, null, null, null, null, null, 22, 23];
  expect(
    stitchCardWindow(metric, ring, history, {
      bucketMs: 10,
      tEndMs: 80,
      firstRingMs: 60,
    })
  ).toEqual([12, 12, null, null, 0, null, 22, 23]);
});

test("a card bucket straddling the seam keeps the ring's value and ignores stored overlap", () => {
  const ring = [null, null, null, null, null, 21, 22, 23];
  expect(
    stitchCardWindow(metric, ring, history, {
      bucketMs: 10,
      tEndMs: 80,
      firstRingMs: 58,
    })
  ).toEqual([12, 12, null, null, 0, 21, 22, 23]);
});
