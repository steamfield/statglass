import { createMockTransport } from "@core/mock-transport";
import { historyKeys } from "@core/query-keys";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { useState } from "react";
import { useHostRecentHistory } from "./use-host-recent-history";

function Probe({
  host = "remote-studio",
  offset = 0,
}: {
  host?: string;
  offset?: number;
}) {
  const { history } = useHostRecentHistory(host, offset);
  return <pre>{JSON.stringify(history)}</pre>;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("queries the requested host's last ten minutes and keeps explicit gaps", async () => {
  const now = 1791000000000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  const transport = createMockTransport({
    scenarios: ["multi-host"],
    autoTick: false,
    now: () => now,
  });
  const query = transport.queryHistory;
  const requests = vi.fn(query);
  transport.queryHistory = async (request) => {
    const result = await requests(request);
    if (result.status === "error") return result;
    return {
      ...result,
      data: {
        ...result.data,
        gaps: [
          {
            start_ms: now - 120000,
            end_ms: now - 60000,
            reason: "source_offline",
            module: null,
          },
        ],
      },
    };
  };
  const subscribe = vi.spyOn(transport, "subscribeLive");
  const view = renderWithProviders(<Probe />, { transport });
  try {
    await waitFor(() =>
      expect(screen.getByText(/cpuGaps/)).toHaveTextContent("Host offline")
    );
    expect(requests).toHaveBeenCalledWith({
      host: "remote-studio",
      selectors: [
        { metric: "cpu.total", labels: [] },
        { metric: "mem.used", labels: [] },
      ],
      from_ms: now - 600000,
      to_ms: now,
      tier: "s10",
      max_points: 61,
    });
    expect(screen.getByText(/cpuGaps/)).toHaveTextContent(
      '"fromMs":1790999880000'
    );
    expect(screen.getByText(/cpuGaps/)).toHaveTextContent(
      '"toMs":1790999940000'
    );
    const cached = view.queryClient.getQueryData<{
      page: import("@core/generated/bindings").HistoryPage;
      fromMs: number;
      toMs: number;
    }>(historyKeys.recent("remote-studio", 0));
    expect(cached?.page.gaps).toHaveLength(1);
    const historyText = screen.getByText(/cpuGaps/).textContent ?? "";
    const parsed: {
      values: Record<string, (number | null)[]>;
      endMs: number;
      bucketMs: number;
    } = JSON.parse(historyText);
    const middle = parsed.values["cpu.total"]?.length
      ? Math.round(
          (now -
            90000 -
            (parsed.endMs -
              ((parsed.values["cpu.total"]?.length ?? 1) - 1) *
                parsed.bucketMs)) /
            parsed.bucketMs
        )
      : -1;
    expect(parsed.values["cpu.total"]?.[middle]).toBeNull();
    expect(parsed.values["mem.used"]?.[middle]).toBeNull();
    expect(screen.getByText(/cpuGaps/)).toHaveTextContent(
      '"showCaption":false'
    );
    expect(
      subscribe.mock.calls.every(([host]) => host !== "remote-studio")
    ).toBe(true);
  } finally {
    view.unmount();
    transport.dispose();
  }
});

it("refetches every ten seconds without a live detail subscription", async () => {
  vi.useFakeTimers();
  const transport = createMockTransport({
    scenarios: ["multi-host"],
    autoTick: false,
  });
  const requests = vi.spyOn(transport, "queryHistory");
  const view = renderWithProviders(<Probe />, { transport });
  try {
    await act(() => vi.advanceTimersByTimeAsync(100));
    const before = requests.mock.calls.length;
    expect(before).toBeGreaterThan(0);
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(requests.mock.calls.length).toBeGreaterThan(before);
    expect(
      transport.calls.filter(
        (call) =>
          call.command === "subscribe_live" && call.args[0] === "remote-studio"
      )
    ).toEqual([]);
  } finally {
    view.unmount();
    transport.dispose();
  }
});

it("retains this host's chart while a corrected clock range is pending", async () => {
  const now = 1791000000000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  const transport = createMockTransport({
    scenarios: ["multi-host"],
    autoTick: false,
    now: () => now,
  });
  const read = transport.queryHistory;
  let release: (() => void) | undefined;
  transport.queryHistory = async (request) => {
    if (request.to_ms === now + 250)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return read(request);
  };
  function ClockCorrection() {
    const [offset, setOffset] = useState(0);
    return (
      <>
        <button type="button" onClick={() => setOffset(250)}>
          Correct clock
        </button>
        <Probe offset={offset} />
      </>
    );
  }
  const view = renderWithProviders(<ClockCorrection />, { transport });
  try {
    await waitFor(() =>
      expect(screen.getByText(/cpuGaps/)).toBeInTheDocument()
    );
    const before = screen.getByText(/cpuGaps/).textContent;
    await view.user.click(
      screen.getByRole("button", { name: "Correct clock" })
    );
    await waitFor(() => expect(release).toBeDefined());
    expect(screen.getByText(/cpuGaps/).textContent).toBe(before);
    await act(async () => release?.());
    await waitFor(() =>
      expect(screen.getByText(/cpuGaps/).textContent).not.toBe(before)
    );
  } finally {
    await act(async () => release?.());
    view.unmount();
    transport.dispose();
  }
});
