import type { CommandResult } from "@core/transport";
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  type DockerOpen,
  useDockerSubscription,
} from "./use-docker-subscription";

/** A channel the test drives: `send` delivers, `resolve` answers the subscribe. */
function channel() {
  let deliver: ((batch: number) => void) | undefined;
  let answer:
    | ((value: {
        info: CommandResult<number>;
        unsubscribe: () => void;
      }) => void)
    | undefined;
  const unsubscribe = vi.fn();
  const open: DockerOpen<number> = (onBatch) => {
    deliver = onBatch;
    return new Promise((done) => {
      answer = done;
    });
  };
  return {
    open,
    unsubscribe,
    send: (batch: number) => deliver?.(batch),
    resolve: (info: CommandResult<number> = { status: "ok", data: 1 }) =>
      answer?.({ info, unsubscribe }),
  };
}

it("delivers batches to the latest handler and stops on unmount", async () => {
  const c = channel();
  const seen: string[] = [];
  const { rerender, unmount } = renderHook(
    ({ tag }: { tag: string }) =>
      useDockerSubscription(c.open, (n) => seen.push(`${tag}${n}`)),
    { initialProps: { tag: "a" } }
  );
  await act(async () => c.resolve());
  act(() => c.send(1));
  rerender({ tag: "b" });
  act(() => c.send(2));
  expect(seen).toEqual(["a1", "b2"]);
  unmount();
  expect(c.unsubscribe).toHaveBeenCalledTimes(1);
  c.send(3);
  expect(seen).toEqual(["a1", "b2"]);
});

it("stops a subscription that answers after unmount", async () => {
  const c = channel();
  const { unmount } = renderHook(() =>
    useDockerSubscription(c.open, () => undefined)
  );
  unmount();
  await act(async () => c.resolve());
  expect(c.unsubscribe).toHaveBeenCalledTimes(1);
});

it("reports a command error and a rejected call", async () => {
  const c = channel();
  const { result } = renderHook(() =>
    useDockerSubscription(c.open, () => undefined)
  );
  await act(async () =>
    c.resolve({
      status: "error",
      error: { kind: "invalid_argument", message: "no engine" },
    })
  );
  expect(result.current).not.toBeNull();

  const rejected: DockerOpen<number> = () =>
    Promise.reject(new Error("ipc closed"));
  const failed = renderHook(() =>
    useDockerSubscription(rejected, () => undefined)
  );
  await waitFor(() => expect(failed.result.current).toBe("Error: ipc closed"));
});

it("does nothing while closed, and clears the error on reopen", async () => {
  const rejected: DockerOpen<number> = () => Promise.reject(new Error("down"));
  const { result, rerender } = renderHook(
    ({ open }: { open: DockerOpen<number> | null }) =>
      useDockerSubscription(open, () => undefined),
    { initialProps: { open: rejected as DockerOpen<number> | null } }
  );
  await waitFor(() => expect(result.current).toBe("Error: down"));
  rerender({ open: null });
  expect(result.current).toBeNull();
});
