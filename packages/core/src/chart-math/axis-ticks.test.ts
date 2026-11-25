import {
  formatBucketTime,
  formatBytes,
  formatClock,
  formatClockSeconds,
  formatPercent,
  formatRate,
  formatWatts,
} from "@core/format";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "@core/time-grid";
import { CHART_CAPTION_CHAR_WIDTH_PX } from "@core/widget-models/chart-annotation";
import { type AxisTick, timeTicks, valueTicks } from "./axis-ticks";
import { niceCeiling } from "./nice-ceiling";

describe("value ticks", () => {
  it.each([
    ["percent", 100, formatPercent, ["0%", "50%", "100%"]],
    ["bytes", 16e9, formatBytes, ["0 B", "8.0 GB", "16.0 GB"]],
    ["rate", niceCeiling(1.3e6), formatRate, ["0 B/s", "1.0 MB/s", "2.0 MB/s"]],
    ["watts", niceCeiling(15), formatWatts, ["0.0 W", "10.0 W", "20.0 W"]],
  ] as const)(
    "labels zero, the midpoint and the %s ceiling",
    (_, ceiling, format, labels) => {
      expect(valueTicks(ceiling, format)).toEqual([
        { value: 0, frac: 0, label: labels[0] },
        { value: ceiling / 2, frac: 0.5, label: labels[1] },
        { value: ceiling, frac: 1, label: labels[2] },
      ]);
    }
  );

  it.each([
    0,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
  ])("labels only the baseline when the ceiling is %s", (ceiling) => {
    expect(valueTicks(ceiling, formatPercent)).toEqual([
      { value: 0, frac: 0, label: "0%" },
    ]);
  });

  it("spaces the requested count evenly, including the baseline and ceiling", () => {
    expect(valueTicks(100, formatPercent, { count: 5 })).toEqual([
      { value: 0, frac: 0, label: "0%" },
      { value: 25, frac: 0.25, label: "25%" },
      { value: 50, frac: 0.5, label: "50%" },
      { value: 75, frac: 0.75, label: "75%" },
      { value: 100, frac: 1, label: "100%" },
    ]);
  });

  it("uses the default ticks when the requested count cannot fit on an axis", () => {
    expect(valueTicks(100, formatPercent, { count: 2 ** 32 })).toEqual([
      { value: 0, frac: 0, label: "0%" },
      { value: 50, frac: 0.5, label: "50%" },
      { value: 100, frac: 1, label: "100%" },
    ]);
  });
});

const toMs = Date.UTC(2026, 10, 25, 18, 3, 17);
const widthPx = 360;
const historical = { clockOffsetMs: 0, nowMs: toMs + MINUTE_MS };
const formatWithDate = (ms: number) => formatBucketTime(ms, MINUTE_MS, true);
const displayedClock = (ms: number) =>
  ms - new Date(ms).getTimezoneOffset() * MINUTE_MS;

function expectLabelsToFit(ticks: AxisTick[], width: number, scale: number) {
  const roundingPx = width * Number.EPSILON;
  let previousRight = 0;
  for (const { frac, label } of ticks) {
    const labelWidth = label.length * CHART_CAPTION_CHAR_WIDTH_PX * scale;
    const left =
      frac * width -
      (frac === 1 ? labelWidth : frac === 0 ? 0 : labelWidth / 2);
    expect(left + roundingPx).toBeGreaterThanOrEqual(previousRight);
    previousRight = left + labelWidth;
    expect(previousRight - roundingPx).toBeLessThanOrEqual(width);
  }
}

describe("time ticks", () => {
  it.each([
    ["5 m", 5 * MINUTE_MS, MINUTE_MS, formatClockSeconds],
    ["1 h", HOUR_MS, 5 * MINUTE_MS, formatClock],
    ["24 h", DAY_MS, HOUR_MS, formatWithDate],
    ["7 d", 7 * DAY_MS, DAY_MS, formatWithDate],
    ["30 d", 30 * DAY_MS, DAY_MS, formatWithDate],
  ] as const)(
    "places evenly spaced clock labels in a %s window",
    (_, span, grid, format) => {
      const fromMs = toMs - span;
      const ticks = timeTicks(fromMs, toMs, widthPx, historical);
      expect(ticks.length).toBeGreaterThan(1);
      const step =
        displayedClock(ticks[1]?.value ?? fromMs) -
        displayedClock(ticks[0]?.value ?? fromMs);
      expect(step).toBeGreaterThan(0);
      for (const [index, tick] of ticks.entries()) {
        expect(displayedClock(tick.value) % grid).toBe(0);
        expect(tick.frac).toBe((tick.value - fromMs) / span);
        expect(tick.label).toBe(format(tick.value));
        const next = ticks[index + 1];
        if (next) {
          expect(displayedClock(next.value) - displayedClock(tick.value)).toBe(
            step
          );
        }
      }
      expectLabelsToFit(ticks, widthPx, 1);
    }
  );

  it.each([-47_000, 47_000])(
    "aligns and labels on the host clock with a %d ms offset",
    (clockOffsetMs) => {
      const hostBoundary = new Date(2026, 10, 25, 13, 5).getTime();
      const value = hostBoundary - clockOffsetMs;
      const from = value - 2 * MINUTE_MS;
      const to = value + 3 * MINUTE_MS;
      const ticks = timeTicks(from, to, widthPx, {
        clockOffsetMs,
        nowMs: to + 1,
      });
      expect(ticks).toContainEqual({ value, frac: 0.4, label: "13:05:00" });
    }
  );

  it.each([
    [
      "Asia/Kolkata",
      Date.UTC(2026, 10, 24, 21, 30),
      ["Nov 25, 06:00", "Nov 25, 12:00", "Nov 25, 18:00", "Nov 26, 00:00"],
    ],
    [
      "America/New_York",
      Date.UTC(2026, 2, 7, 20),
      ["Mar 7, 18:00", "Mar 8, 00:00", "Mar 8, 06:00", "Mar 8, 12:00"],
    ],
  ] as const)(
    "follows the displayed clock grid in %s",
    (zone, hostFrom, labels) => {
      vi.stubEnv("TZ", zone);
      try {
        const offset = 47_000;
        const from = hostFrom - offset;
        const to = from + DAY_MS;
        const ticks = timeTicks(from, to, 400, {
          clockOffsetMs: offset,
          nowMs: to + 1,
        });
        expect(ticks.map(({ label }) => label)).toEqual(labels);
      } finally {
        vi.unstubAllEnvs();
      }
    }
  );

  it("uses fewer ticks at a larger caption scale and reserves room for now", () => {
    const to = toMs + 8_000;
    const from = to - 5 * MINUTE_MS;
    const width = 320;
    const opts = { clockOffsetMs: 0, nowMs: to };
    const standard = timeTicks(from, to, width, opts);
    const larger = timeTicks(from, to, width, {
      ...opts,
      captionScale: 1.5,
    });
    expect(larger.length).toBeGreaterThan(1);
    expect(larger.length).toBeLessThan(standard.length);
    expect(larger.at(-1)).toEqual({ value: to, frac: 1, label: "now" });
    expectLabelsToFit(standard, width, 1);
    expectLabelsToFit(larger, width, 1.5);
  });

  it("labels a grid-aligned right edge as now only at the supplied present time", () => {
    const to = Date.UTC(2026, 10, 25, 18);
    const from = to - 5 * MINUTE_MS;
    const clockOffsetMs = MINUTE_MS;
    const live = timeTicks(from, to, widthPx, { clockOffsetMs, nowMs: to });
    const paused = timeTicks(from, to, widthPx, {
      clockOffsetMs,
      nowMs: to + 1,
    });
    expect(live.filter(({ frac }) => frac === 1)).toEqual([
      { value: to, frac: 1, label: "now" },
    ]);
    expect(paused.filter(({ frac }) => frac === 1)).toEqual([
      { value: to, frac: 1, label: formatClockSeconds(to + clockOffsetMs) },
    ]);
    expect(paused.map(({ label }) => label)).not.toContain("now");
  });

  it("keeps now as the only label when a narrow plot cannot fit another tick", () => {
    expect(
      timeTicks(toMs - 5 * MINUTE_MS, toMs, 25, {
        clockOffsetMs: 0,
        nowMs: toMs,
      })
    ).toEqual([{ value: toMs, frac: 1, label: "now" }]);
  });

  it("leaves the axis empty when the present label would clip", () => {
    expect(
      timeTicks(toMs - 5 * MINUTE_MS, toMs, 25, {
        clockOffsetMs: 0,
        nowMs: toMs,
        captionScale: 1.5,
      })
    ).toEqual([]);
  });

  it.each([false, true])(
    "keeps a date label at larger text sizes in a 30-day window (live: %s)",
    (live) => {
      const from = 29 * DAY_MS;
      const to = from + 30 * DAY_MS;
      const width = 250;
      const captionScale = 1.5;
      const ticks = timeTicks(from, to, width, {
        clockOffsetMs: 0,
        nowMs: live ? to : to + 1,
        captionScale,
      });
      expect(
        ticks.filter(({ label }) => label !== "now").length
      ).toBeGreaterThan(0);
      expect(ticks.some(({ label }) => label === "now")).toBe(live);
      expectLabelsToFit(ticks, width, captionScale);
    }
  );

  it.each([
    [toMs, toMs, widthPx],
    [toMs + 1, toMs, widthPx],
    [toMs - MINUTE_MS, toMs, 0],
    [toMs - MINUTE_MS, Number.POSITIVE_INFINITY, widthPx],
  ])(
    "returns no ticks for unusable bounds or width (%s, %s, %s)",
    (from, to, width) => {
      expect(timeTicks(from, to, width, { ...historical, nowMs: to })).toEqual(
        []
      );
    }
  );
});
