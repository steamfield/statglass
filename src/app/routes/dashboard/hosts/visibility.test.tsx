import { createMockTransport } from "@core/mock-transport";
import { act, cleanup, screen } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { useRemoteHosts } from "~/hooks/use-remote-hosts";
import { makeQueryClient } from "~/lib/query";

function HostList() {
  const { data } = useRemoteHosts();
  return <output>{data?.length ?? "Loading"}</output>;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("recovers polling after a failed startup visibility read without a visibility transition", async () => {
  vi.useFakeTimers();
  const transport = createMockTransport({
    scenarios: ["hosts-dashboard"],
    historyRows: 1,
  });
  const failure = new Error("IPC temporarily unavailable");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const visibility = vi
    .spyOn(transport, "windowVisible")
    .mockRejectedValueOnce(failure)
    .mockResolvedValue(true);
  const list = vi.spyOn(transport, "listRemoteHosts");
  const view = renderWithProviders(<HostList />, {
    transport,
    queryClient: makeQueryClient(),
  });
  try {
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(visibility).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      "[query] reading native window visibility",
      failure
    );
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(list).toHaveBeenCalledTimes(2);
  } finally {
    view.unmount();
    view.queryClient.clear();
    transport.dispose();
  }
});

it.each(["hide", "unmount"])(
  "cancels pending visibility retries on %s",
  async (action) => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const transport = createMockTransport({ historyRows: 1 });
    const visibility = vi
      .spyOn(transport, "windowVisible")
      .mockRejectedValue(new Error("IPC unavailable"));
    const view = renderWithProviders(<HostList />, {
      transport,
      queryClient: makeQueryClient(),
    });
    try {
      await act(() => vi.advanceTimersByTimeAsync(10));
      expect(visibility).toHaveBeenCalledTimes(1);
      if (action === "hide") act(() => transport.setWindowVisible(false));
      else view.unmount();
      await act(() => vi.advanceTimersByTimeAsync(60000));
      expect(visibility).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
      view.queryClient.clear();
      transport.dispose();
    }
  }
);

it("pauses the Hosts list's five-second poll while hidden and resumes on show", async () => {
  vi.useFakeTimers();
  const transport = createMockTransport({
    scenarios: ["hosts-dashboard"],
    historyRows: 1,
  });
  const list = vi.spyOn(transport, "listRemoteHosts");
  const view = renderWithProviders(<HostList />, {
    transport,
    queryClient: makeQueryClient(),
  });
  try {
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(screen.getByRole("status")).toHaveTextContent("5");
    expect(list).toHaveBeenCalledTimes(1);
    act(() => transport.setWindowVisible(false));
    await act(() => vi.advanceTimersByTimeAsync(15000));
    expect(list).toHaveBeenCalledTimes(1);
    act(() => transport.setWindowVisible(true));
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(list).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(list).toHaveBeenCalledTimes(3);
  } finally {
    view.unmount();
    view.queryClient.clear();
    transport.dispose();
  }
});

it("starts paused when mounted into an already hidden window", async () => {
  vi.useFakeTimers();
  const transport = createMockTransport({
    scenarios: ["hosts-dashboard"],
    historyRows: 1,
  });
  transport.setWindowVisible(false);
  const list = vi.spyOn(transport, "listRemoteHosts");
  const view = renderWithProviders(<HostList />, {
    transport,
    queryClient: makeQueryClient(),
  });
  try {
    await act(() => vi.advanceTimersByTimeAsync(15000));
    expect(list).toHaveBeenCalledTimes(1);
    act(() => transport.setWindowVisible(true));
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(list).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(list).toHaveBeenCalledTimes(3);
  } finally {
    view.unmount();
    view.queryClient.clear();
    transport.dispose();
  }
});

it("ignores a stale startup response after receiving a visibility event", async () => {
  vi.useFakeTimers();
  const transport = createMockTransport({
    scenarios: ["hosts-dashboard"],
    historyRows: 1,
  });
  let resolveVisibility: ((visible: boolean) => void) | undefined;
  vi.spyOn(transport, "windowVisible").mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveVisibility = resolve;
      })
  );
  const list = vi.spyOn(transport, "listRemoteHosts");
  const view = renderWithProviders(<HostList />, {
    transport,
    queryClient: makeQueryClient(),
  });
  try {
    await act(() => vi.advanceTimersByTimeAsync(10));
    act(() => transport.setWindowVisible(false));
    await act(async () => resolveVisibility?.(true));
    await act(() => vi.advanceTimersByTimeAsync(15000));
    expect(list).toHaveBeenCalledTimes(1);
    act(() => transport.setWindowVisible(true));
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(list).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(list).toHaveBeenCalledTimes(3);
  } finally {
    view.unmount();
    view.queryClient.clear();
    transport.dispose();
  }
});
