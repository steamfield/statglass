import { renderHook } from "@testing-library/react";
import { useNiceCeiling } from "./use-nice-ceiling";

type Props = { values: number[]; nowMs: number; windowMs: number };

function setup(initial: Props) {
  return renderHook(
    ({ values, nowMs, windowMs }: Props) =>
      useNiceCeiling(values, nowMs, 1, windowMs),
    { initialProps: initial }
  );
}

describe("useNiceCeiling", () => {
  it("fits a newly selected series even when its newest point time is unchanged", () => {
    const { result, rerender } = setup({
      values: [19],
      nowMs: 1000,
      windowMs: 300_000,
    });
    expect(result.current).toBe(20);
    rerender({ values: [19, 350], nowMs: 1000, windowMs: 300_000 });
    expect(result.current).toBeGreaterThanOrEqual(350);
  });
  it("holds a higher ceiling for 60 s while the window stays the same", () => {
    const { result, rerender } = setup({
      values: [19],
      nowMs: 1000,
      windowMs: 300_000,
    });
    expect(result.current).toBe(20);
    rerender({ values: [3], nowMs: 2000, windowMs: 300_000 });
    expect(result.current).toBe(20);
  });

  it("fits the new window's data at once when the window changes", () => {
    const { result, rerender } = setup({
      values: [19],
      nowMs: 1000,
      windowMs: 300_000,
    });
    rerender({ values: [3], nowMs: 2000, windowMs: 900_000 });
    expect(result.current).toBe(4);
  });

  it("refits on a window change even before the next tick", () => {
    const { result, rerender } = setup({
      values: [19],
      nowMs: 1000,
      windowMs: 300_000,
    });
    rerender({ values: [3], nowMs: 1000, windowMs: 900_000 });
    expect(result.current).toBe(4);
  });

  it("shrinks a 6 h history-backed window whose updates arrive a bucket (18 s) apart", () => {
    const BUCKET_MS = 18_000;
    const { result, rerender } = renderHook(
      ({ values, nowMs }: { values: number[]; nowMs: number }) =>
        useNiceCeiling(values, nowMs, 1, 21_600_000, {
          intervalMs: BUCKET_MS,
        }),
      { initialProps: { values: [3, 75], nowMs: 0 } }
    );
    expect(result.current).toBe(80);
    // The peak has left the window; every later update reads 3.
    for (let k = 1; k <= 5; k++)
      rerender({ values: [3], nowMs: k * BUCKET_MS });
    expect(result.current).toBe(4);
  });

  it("refits when a fixed range moves its end with the same window", () => {
    type Range = { values: number[]; endMs: number | null };
    const live: Range = { values: [75], endMs: null };
    const { result, rerender } = renderHook(
      ({ values, endMs }: Range) =>
        useNiceCeiling(values, 1000, 1, 300_000, { endMs }),
      { initialProps: live }
    );
    expect(result.current).toBe(80);
    rerender({ values: [3], endMs: 500_000 });
    expect(result.current).toBe(4);
  });
});
