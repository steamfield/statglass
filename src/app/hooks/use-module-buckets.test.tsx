import { act } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { useModuleBuckets } from "./use-module-buckets";

it("keeps ring loading separate from retained-history query loading", async () => {
  vi.useFakeTimers();
  let latest: ReturnType<typeof useModuleBuckets> | undefined;
  function Probe() {
    latest = useModuleBuckets(["cpu.total"], 60_000, 60, 3_600_000);
    return null;
  }
  const r = renderWithProviders(<Probe />, {
    transportOptions: { historyRows: 3600 },
    backfillMs: 3_600_000,
  });
  try {
    await act(async () => {});
    expect(latest?.ringLoading).toBe(true);
    expect(latest?.loading).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(latest?.ringLoading).toBe(false);
    expect(latest?.loading).toBe(false);
  } finally {
    r.unmount();
    r.transport.dispose();
    vi.useRealTimers();
  }
});
