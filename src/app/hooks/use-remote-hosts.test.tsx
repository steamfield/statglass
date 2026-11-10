import { createMockTransport, type MockTransport } from "@core/mock-transport";
import { act, cleanup, render, screen } from "@testing-library/react";
import { App } from "~/app";

const sources: MockTransport[] = [];
afterEach(() => {
  cleanup();
  for (const source of sources.splice(0)) source.dispose();
  vi.useRealTimers();
});

it("registers one remote event listener for all Hosts page consumers", async () => {
  const transport = createMockTransport({
    scenarios: ["hosts-dashboard"],
    autoTick: false,
    windowLabel: "dashboard",
  });
  sources.push(transport);
  const listen = vi.spyOn(transport, "onRemoteHostsChanged");
  const view = render(
    <App transport={transport} router={{ initialEntry: "/dashboard/hosts" }} />
  );
  await screen.findByRole("region", { name: "studio" });
  expect(screen.getAllByRole("button", { name: "View metrics" })).toHaveLength(
    6
  );
  expect(listen).toHaveBeenCalledTimes(1);
  view.unmount();
});

it("does not refetch on a remote event while hidden and catches up when shown", async () => {
  vi.useFakeTimers();
  const transport = createMockTransport({
    scenarios: ["hosts-dashboard"],
    autoTick: false,
    windowLabel: "dashboard",
  });
  sources.push(transport);
  const list = vi.spyOn(transport, "listRemoteHosts");
  render(
    <App transport={transport} router={{ initialEntry: "/dashboard/hosts" }} />
  );
  await act(() => vi.advanceTimersByTimeAsync(100));
  expect(list.mock.calls.length).toBeGreaterThan(0);
  act(() => transport.setWindowVisible(false));
  const before = list.mock.calls.length;
  act(() => transport.pushRemoteStatus("remote-build", { state: "offline" }));
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(list).toHaveBeenCalledTimes(before);
  act(() => transport.setWindowVisible(true));
  await act(() => vi.advanceTimersByTimeAsync(100));
  expect(list).toHaveBeenCalledTimes(before + 1);
  expect(screen.getByRole("region", { name: "build" })).toHaveTextContent(
    "Offline"
  );
});

it("refetches recent history once when the selected remote clock steps", async () => {
  vi.useFakeTimers();
  const transport = createMockTransport({
    scenarios: ["hosts-dashboard"],
    autoTick: false,
    windowLabel: "dashboard",
    historyRows: 1,
  });
  sources.push(transport);
  const read = vi.spyOn(transport, "queryHistory");
  render(
    <App
      transport={transport}
      initialHost="remote-build"
      router={{ initialEntry: "/dashboard/hosts" }}
    />
  );
  await act(() => vi.advanceTimersByTimeAsync(100));
  const reads = () =>
    read.mock.calls.filter(([request]) => request.host === "remote-build");
  expect(reads()).toHaveLength(1);
  act(() =>
    transport.pushRemoteStatus("remote-build", { clock_offset_ms: 2000 })
  );
  await act(() => vi.advanceTimersByTimeAsync(100));
  expect(reads()).toHaveLength(2);
});
