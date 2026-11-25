import {
  formatBucketTime,
  formatClock,
  formatClockSeconds,
  formatDateTime,
  formatHistoryTime,
  MISSING,
  MONTHS,
  monthName,
  pad2,
  WEEKDAYS,
  WEEKDAYS_2,
  weekdayName,
} from "@core/format";

/** Local time, so the labels read the same in any time zone. */
const at = (month: number, day: number, h = 0, m = 0, s = 0) =>
  new Date(2026, month - 1, day, h, m, s).getTime();

describe("formatClock", () => {
  it("is a 24-hour HH:MM with padded hours and minutes", () => {
    expect(formatClock(at(10, 4, 6, 5))).toBe("06:05");
    expect(formatClock(at(10, 4, 0, 0))).toBe("00:00");
    expect(formatClock(at(10, 4, 23, 59, 59))).toBe("23:59");
  });
});

describe("formatClockSeconds", () => {
  it("adds padded seconds and renders missing input as a dash", () => {
    expect(formatClockSeconds(at(10, 4, 9, 5, 7))).toBe("09:05:07");
    expect(formatClockSeconds(at(10, 4, 23, 59, 59))).toBe("23:59:59");
    expect(formatClockSeconds(Number.NaN)).toBe(MISSING);
  });
});

describe("formatDateTime", () => {
  it("is the local month, day and 24-hour time with seconds", () => {
    expect(formatDateTime(at(10, 4, 9, 5, 7))).toBe("Oct 4, 09:05:07");
    expect(formatDateTime(at(1, 31, 23, 59, 59))).toBe("Jan 31, 23:59:59");
    expect(formatHistoryTime(at(10, 4, 9, 5, 7), true)).toBe("Oct 4, 09:05:07");
    expect(formatHistoryTime(at(10, 4, 9, 5, 7), false)).toBe("09:05:07");
  });

  it("adds the year for another year only when asked", () => {
    const year = new Date().getFullYear();
    const old = new Date(year - 1, 9, 5, 14, 2, 10).getTime();
    const now = new Date(year, 9, 5, 14, 2, 10).getTime();
    expect(formatDateTime(old)).toBe("Oct 5, 14:02:10");
    expect(formatDateTime(old, { yearUnlessCurrent: true })).toBe(
      `Oct 5, ${year - 1}, 14:02:10`
    );
    expect(formatDateTime(now, { yearUnlessCurrent: true })).toBe(
      "Oct 5, 14:02:10"
    );
  });

  it("renders a missing time as a dash", () => {
    expect(formatDateTime(null)).toBe(MISSING);
    expect(formatDateTime(Number.NaN)).toBe(MISSING);
  });
});

describe("formatBucketTime", () => {
  it("shows seconds only for buckets under a minute, and the date when asked", () => {
    expect(formatBucketTime(at(10, 4, 9, 5, 10), 10_000, false)).toBe(
      "09:05:10"
    );
    expect(formatBucketTime(at(10, 4, 9, 5), 60_000, false)).toBe("09:05");
    expect(formatBucketTime(at(10, 4, 9, 0), 3_600_000, true)).toBe(
      "Oct 4, 09:00"
    );
    expect(formatBucketTime(at(10, 4, 9, 5, 10), 10_000, true)).toBe(
      "Oct 4, 09:05:10"
    );
  });
});

describe("month and weekday tables", () => {
  it("names each month by its local month", () => {
    expect(MONTHS.join(" ")).toBe(
      "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec"
    );
    expect(monthName(new Date(2026, 9, 31, 23, 59))).toBe("Oct");
  });

  it("names each weekday from Sunday", () => {
    expect(WEEKDAYS.join(" ")).toBe("Sun Mon Tue Wed Thu Fri Sat");
    expect(WEEKDAYS_2.join(" ")).toBe("Su Mo Tu We Th Fr Sa");
    // Sun Oct 4 2026.
    expect(weekdayName(new Date(2026, 9, 4))).toBe("Sun");
    expect(weekdayName(new Date(2026, 9, 10))).toBe("Sat");
  });

  it("pads to two digits", () => {
    expect(pad2(5)).toBe("05");
    expect(pad2(12)).toBe("12");
  });
});
