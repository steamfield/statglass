import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { createMockTransport } from "@core/mock-transport";
import { renderHook, waitFor } from "@testing-library/react";
import { createTestQueryClient } from "@tests/test-utils";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useRangeQuery } from "~/lib/queries/range";
import { QueryProvider } from "~/lib/query";
import { TransportProvider } from "~/lib/transport-context";
import { HostStoreProvider } from "~/stores/host-store";

let transport = createMockTransport({ autoTick: false });
beforeEach(() => {
  transport = createMockTransport({ autoTick: false });
});
afterEach(() => transport.dispose());

/**
 * A rolling range view whose answers come from `answers[host]`; the host
 * is read from `host.current` on every render, so a rerender switches it
 * without remounting the hook.
 */
function renderRolling(answers: Record<string, Promise<string>>) {
  const host = { current: MOCK_HOST_ID };
  const client = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <TransportProvider transport={transport}>
      <QueryProvider client={client}>
        <HostStoreProvider hostId={host.current}>{children}</HostStoreProvider>
      </QueryProvider>
    </TransportProvider>
  );
  const view = renderHook(
    ({ toMs, spanMs = 10 }: { toMs: number; spanMs?: number }) =>
      useRangeQuery<string>(
        { fromMs: toMs - spanMs, toMs },
        {
          key: (hostId, fromMs, to) => ["history", hostId, "test", fromMs, to],
          fetch: (_transport, hostId) =>
            answers[hostId] ?? Promise.reject(new Error("no answer")),
          isFinal: () => true,
          keepPrevious: true,
        }
      ),
    { wrapper, initialProps: { toMs: 10 } as { toMs: number; spanMs?: number } }
  );
  return { ...view, host };
}

const pending = () => new Promise<string>(() => undefined);

it("holds a rolling answer while the window moves on the same host", async () => {
  const answers = { [MOCK_HOST_ID]: Promise.resolve("first") };
  const { result, rerender } = renderRolling(answers);
  await waitFor(() => expect(result.current.data).toBe("first"));
  answers[MOCK_HOST_ID] = pending();
  rerender({ toMs: 20 });
  expect(result.current.isPlaceholderData).toBe(true);
  expect(result.current.data).toBe("first");
});

it("clears the held answer when the host switches", async () => {
  const answers = {
    [MOCK_HOST_ID]: Promise.resolve("first host"),
    other: pending(),
  };
  const { result, rerender, host } = renderRolling(answers);
  await waitFor(() => expect(result.current.data).toBe("first host"));
  host.current = "other";
  rerender({ toMs: 20 });
  expect(result.current.isPlaceholderData).toBe(false);
  expect(result.current.data).toBeUndefined();
});

it("clears the held answer when the window's span changes", async () => {
  const answers = { [MOCK_HOST_ID]: Promise.resolve("one hour") };
  const { result, rerender } = renderRolling(answers);
  await waitFor(() => expect(result.current.data).toBe("one hour"));
  answers[MOCK_HOST_ID] = pending();
  rerender({ toMs: 20, spanMs: 20 });
  expect(result.current.isPlaceholderData).toBe(false);
  expect(result.current.data).toBeUndefined();
});
