import { describe, expect, it } from "vitest";
import { mockBuckets, rangeError } from "./protocol";

describe("rangeError", () => {
  it("accepts a forward range up to the limit", () => {
    expect(rangeError(10, 20, 10)).toBeNull();
    expect(rangeError(0, Number.MAX_SAFE_INTEGER)).toBeNull();
  });

  it("refuses empty and backwards ranges with Rust's text", () => {
    const empty = "the range is empty: its start (5) is not before its end (5)";
    expect(rangeError(5, 5)).toBe(empty);
    expect(rangeError(9, 3)).toBe(
      "the range is empty: its start (9) is not before its end (3)"
    );
  });

  it("names the limit in days, hours or ms, as Rust's Span does", () => {
    const day = 86_400_000;
    expect(rangeError(0, 91 * day, 90 * day)).toBe(
      "the range is longer than 90 days"
    );
    expect(rangeError(0, 2 * day, day)).toBe("the range is longer than 1 day");
    expect(rangeError(0, day, 3_600_000)).toBe(
      "the range is longer than 1 hour"
    );
    expect(rangeError(0, day, 3_610_000)).toBe(
      "the range is longer than 3610000 ms"
    );
  });
});

describe("mockBuckets", () => {
  it("starts at the bucket holding the start and keeps whole buckets when they fit", () => {
    expect(mockBuckets(25_000, 85_000, 10_000, 100)).toEqual({
      first: 20_000,
      step: 10_000,
    });
  });

  it("merges the fewest buckets per run that keep the count at max_points", () => {
    // Buckets from 20 s to 85 s: 7, so runs of 4 for two points.
    expect(mockBuckets(25_000, 85_000, 10_000, 2)).toEqual({
      first: 20_000,
      step: 40_000,
    });
    // A zero max_points reads as one.
    expect(mockBuckets(0, 60_000, 10_000, 0).step).toBe(60_000);
  });
});
