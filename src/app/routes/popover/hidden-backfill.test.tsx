import { createMockTransport } from "@core/mock-transport";
import { act } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { LiveCpuCard } from "./_components/popover-cards";

it("stops scanning when a popover is hidden during slow backfill", async () => {
  vi.useFakeTimers();
  const transport = createMockTransport({
    autoTick: false,
    historyRows: 120,
    intervalMs: 30_000,
  });
  const r = renderWithProviders(<LiveCpuCard onToggle={() => {}} />, {
    transport,
    backfillMs: 3_600_000,
  });
  try {
    await act(async () => {});
    expect(r.container.querySelector("[data-chart-loading]")).not.toBeNull();
    act(() => transport.setWindowVisible(false));
    expect(r.container.querySelector("[data-chart-loading]")).toBeNull();
  } finally {
    r.unmount();
    transport.dispose();
    vi.useRealTimers();
  }
});
