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

it("leaves no timer behind when unmounted while the copy is pending", async () => {
  let resolve = () => {};
  writeText.mockReturnValue(
    new Promise<void>((done) => {
      resolve = done;
    })
  );
  const { result, unmount } = renderHook(() => useCopyToClipboard("test"));
  let copying: Promise<boolean> = Promise.resolve(false);
  act(() => {
    copying = result.current.copy("x");
  });
  unmount();
  resolve();
  await expect(copying).resolves.toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("clears its timer when unmounted after a copy", async () => {
  writeText.mockResolvedValue();
  const { result, unmount } = renderHook(() => useCopyToClipboard("test"));
  await act(async () => {
    await result.current.copy("x");
  });
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
