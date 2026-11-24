import { USAGE_KEEP_MS } from "@core/generated/bindings";
import {
  chartRange,
  chartRangeLabel,
  customRange,
  dateInput,
  MAX_RANGE_MS,
  parseDateInput,
  recordedDate,
  recordedProcessStart,
  usageHistorical,
  validChartRange,
  windowEnding,
} from "./chart-range";

describe("chart ranges", () => {
  it("preserves arbitrary durations instead of rounding to an hour", () => {
    expect(chartRange({ relative: 5_400_000 })).toEqual({
      windowMs: 5_400_000,
      endMs: null,
    });
    expect(chartRangeLabel({ relative: 5_400_000 })).toBe("90m");
    expect(chartRangeLabel({ relative: 172_800_000 })).toBe("2d");
  });
  it.each([0, -1, NaN, Infinity, 59_999, MAX_RANGE_MS + 1])(
    "rejects duration %s",
    (relative) => {
      expect(validChartRange({ relative })).toBe(false);
    }
  );
  it("rejects reversed dates, unsafe timestamps and pre-epoch dates", () => {
    for (const absolute of [
      { from_ms: 90_000, to_ms: 60_000 },
      { from_ms: -1, to_ms: 90_000 },
      {
        from_ms: Number.MAX_SAFE_INTEGER - 60_000,
        to_ms: Number.MAX_SAFE_INTEGER + 1,
      },
    ]) {
      expect(validChartRange({ absolute })).toBe(false);
    }
  });
  it("validates real local dates, including leap years", () => {
    expect(parseDateInput("2026-02-30 12:00")).toBeNull();
    expect(parseDateInput("2026-01-12 25:00")).toBeNull();
    expect(parseDateInput("1/12/2026")).toBeNull();
    const leap = parseDateInput("2024-02-29 12:00");
    expect(leap).not.toBeNull();
    expect(dateInput(leap as number)).toBe("2024-02-29 12:00");
  });
  it("accepts a custom shortcut duration and rejects future dates", () => {
    const draft = {
      mode: "relative",
      amount: "5",
      unitMs: 60_000,
      from: "2026-01-01 10:00",
      to: "2026-01-01 12:00",
      now: new Date("2026-01-01T11:00").getTime(),
      intervalMs: 1000,
    };
    expect(customRange(draft)).toEqual({ value: "5m" });
    expect(customRange({ ...draft, mode: "absolute" })).toEqual({
      error: "The end time must be now or earlier.",
    });
    expect(customRange({ ...draft, intervalMs: 60_000 })).toHaveProperty(
      "error"
    );
  });
});

it("preserves selected seconds and distinguishes process starts within a millisecond", () => {
  const ms = new Date("2026-10-26T12:34:50.123").getTime();
  expect(recordedDate(ms)).toBe("2026-10-26 12:34:50.123");
  expect(recordedProcessStart(ms * 1000 + 1)).toBe(
    "2026-10-26 12:34:50.123001"
  );
  expect(recordedProcessStart(ms * 1000 + 2)).toBe(
    "2026-10-26 12:34:50.123002"
  );
});

describe("windowEnding", () => {
  it("ends a fixed window at the given end", () => {
    expect(windowEnding(10_000_000, 3_600_000)).toEqual({
      absolute: { from_ms: 6_400_000, to_ms: 10_000_000 },
    });
  });
  it("follows now without an end, naming a preset when one matches", () => {
    expect(windowEnding(null, 3_600_000)).toBe("1h");
    expect(windowEnding(null, 5_400_000)).toEqual({ relative: 5_400_000 });
  });
});

describe("usageHistorical", () => {
  it("reads retained usage for a fixed end or a window past the live ring", () => {
    expect(usageHistorical({ windowMs: USAGE_KEEP_MS, endMs: null })).toBe(
      false
    );
    expect(usageHistorical({ windowMs: USAGE_KEEP_MS + 1, endMs: null })).toBe(
      true
    );
    expect(usageHistorical({ windowMs: 60_000, endMs: 1_000_000 })).toBe(true);
  });
});
