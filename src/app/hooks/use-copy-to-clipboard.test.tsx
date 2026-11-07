import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { COPIED_MS, useCopyToClipboard } from "./use-copy-to-clipboard";

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  writeText.mockReset();
});

it("says copied with the text, then resets", async () => {
  writeText.mockResolvedValue();
  const { result } = renderHook(() => useCopyToClipboard("test"));
  let ok = false;
  await act(async () => {
    ok = await result.current.copy("/Users/me");
  });
  expect(ok).toBe(true);
  expect(writeText).toHaveBeenCalledWith("/Users/me");
  expect(result.current).toMatchObject({ status: "copied", text: "/Users/me" });
  act(() => vi.advanceTimersByTime(COPIED_MS));
  expect(result.current).toMatchObject({ status: "idle", text: null });
});

it("says failed when the clipboard refuses, then resets", async () => {
  writeText.mockRejectedValue(new Error("denied"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const { result } = renderHook(() => useCopyToClipboard("test"));
  let ok = true;
  await act(async () => {
    ok = await result.current.copy("x");
  });
  expect(ok).toBe(false);
  expect(result.current).toMatchObject({ status: "failed", text: null });
  expect(log).toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(COPIED_MS));
  expect(result.current.status).toBe("idle");
});
