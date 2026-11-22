import { act, renderHook } from "@testing-library/react";
import { useSecondsUntil } from "./use-seconds-until";

describe("useSecondsUntil", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_795_000_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it("counts down once a second and stops at zero", () => {
    const { result } = renderHook(() =>
      useSecondsUntil(1_795_000_000_000 + 2_500)
    );
    expect(result.current).toBe(3);
    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current).toBe(2);
    act(() => vi.advanceTimersByTime(5_000));
    expect(result.current).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns null and keeps no timer without a target", () => {
    const { result } = renderHook(() => useSecondsUntil(null));
    expect(result.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restarts when the target moves", () => {
    const { result, rerender } = renderHook(
      ({ target }) => useSecondsUntil(target),
      { initialProps: { target: 1_795_000_000_000 + 1_000 } }
    );
    act(() => vi.advanceTimersByTime(2_000));
    expect(result.current).toBe(0);
    rerender({ target: Date.now() + 10_000 });
    expect(result.current).toBe(10);
  });
});
