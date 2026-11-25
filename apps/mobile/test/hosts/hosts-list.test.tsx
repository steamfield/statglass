import type { HistoryRequest } from "@core/generated/types";
import { createMockTransport } from "@core/mock-transport";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { ExpoRoot, router, Stack, useLocalSearchParams } from "expo-router";
import {
  act,
  fireEvent,
  getMockContext,
  screen,
  waitFor,
} from "expo-router/testing-library";
import HostsLayout from "@/app/(hosts)/_layout";
import HostsRoute from "@/app/(hosts)/index";
import type { PhoneSettings } from "@/data/phone-settings";
import { Text } from "@/ui/text";
import * as Chart from "@/widgets/stream-area";

const NOW = Date.UTC(2026, 10, 24, 14, 0);
const MINUTE = 60_000;

function HostDetails() {
  const { host } = useLocalSearchParams();
  return <Text role="title">{`Details for ${host}`}</Text>;
}

const routes = getMockContext({
  _layout: () => <Stack />,
  index: () => <Text role="title">First launch</Text>,
  "(hosts)/_layout": HostsLayout,
  "(hosts)/index": HostsRoute,
  "(hosts)/[host]/index": HostDetails,
  "(hosts)/[host]/[module]": HostDetails,
  "settings/index": () => <Text role="title">Settings screen</Text>,
  pair: () => <Text role="title">Pairing screen</Text>,
  demo: () => <Text role="title">Demo entry</Text>,
});

function renderHosts(
  transport?: ReturnType<typeof createMockTransport>,
  settings?: Partial<PhoneSettings>
) {
  return renderWithProviders(
    <ExpoRoot context={routes} location="/(hosts)" />,
    {
      ...(transport ? { transport } : {}),
      ...(settings ? { settings } : {}),
      demo: true,
    }
  );
}

function demo() {
  return createMockTransport({
    scenarios: ["hosts-dashboard", "host-incompatible"],
  });
}

function pullToRefresh() {
  const [control] = screen.container.queryAll(
    (node) => node.type === "RCTRefreshControl"
  );
  if (!control) throw new Error("Expected the iOS pull-to-refresh control");
  return fireEvent(control, "refresh");
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

test("shows local and remote hosts in phone order with OS, statuses and headline readings", async () => {
  const transport = demo();
  const records = await transport.listHosts();
  transport.pushRemoteStatus("remote-build", {
    state: "connecting",
    error: null,
  });
  transport.pushRemoteStatus("remote-offline", {
    last_seen_ms: NOW,
    clock_offset_ms: 2 * MINUTE,
  });
  await renderHosts(transport, {
    hostOrder: ["remote-build"],
    hostNames: { "remote-build": "Build server" },
  });

  const build = await screen.findByRole("button", {
    name: /^Build server, Linux, Connecting, CPU 18%, Memory 42%, Network 1\.4 MB\/s/,
  });
  expect(
    screen.getAllByRole("button", { name: /CPU.*, Memory.*, Network/ })
  ).toHaveLength(records.length);
  expect(
    screen.getAllByRole("button", { name: /CPU.*, Memory.*, Network/ })[0]
  ).toBe(build);
  expect(
    screen.getByRole("button", { name: /macOS, Live, CPU 18%, Memory 42%/ })
  ).toBeOnTheScreen();
  expect(
    screen.getByRole("button", { name: /offline, Linux, Offline since 14:02/ })
  ).toBeOnTheScreen();
  expect(
    screen.getByRole("button", { name: /legacy, Linux, Needs attention/ })
  ).toBeOnTheScreen();
  expect(screen.getByText("Demo")).toBeOnTheScreen();
  await fireEvent.press(build);
  expect(
    await screen.findByRole("header", { name: "Details for remote-build" })
  ).toBeOnTheScreen();
});

test("uses minute CPU buckets, preserves a missing slot, and polls only while focused", async () => {
  const transport = createMockTransport();
  const chart = jest.spyOn(Chart, "StreamArea");
  const vitals = jest.spyOn(transport, "hostVitals");
  const history = jest
    .spyOn(transport, "queryHistory")
    .mockImplementation(async (request: HistoryRequest) => ({
      status: "ok",
      data: {
        tier: "m1",
        bucket_ms: MINUTE,
        gaps: [],
        series: [
          {
            key: { metric: "cpu.total", labels: [] },
            hold_ms: MINUTE,
            points: [
              { t: request.from_ms, min: 11, max: 13, avg: 12 },
              { t: request.from_ms + 2 * MINUTE, min: 15, max: 17, avg: 16 },
            ],
          },
        ],
      },
    }));
  const [local] = await transport.listHosts();
  await renderHosts(transport);
  await waitFor(() => expect(chart).toHaveBeenCalled());
  const request = history.mock.calls[0]?.[0];
  if (!request || !local)
    throw new Error("Expected the local host and its history request");
  expect(request).toMatchObject({
    host: local.id,
    tier: "m1",
    selectors: [{ metric: "cpu.total", labels: [] }],
    max_points: 31,
  });
  expect(request.to_ms - request.from_ms).toBe(30 * MINUTE);
  const [data] = chart.mock.lastCall ?? [];
  expect(data).toMatchObject({
    accent: "cpu",
    intervalMs: MINUTE,
    tEndMs: request.to_ms - MINUTE,
    yMax: 100,
    series: [
      {
        key: "cpu.total",
        values: [12, null, 16, ...Array(27).fill(null)],
        step: 1,
      },
    ],
  });

  await act(() => jest.advanceTimersByTimeAsync(5_000));
  expect(vitals).toHaveBeenCalledTimes(2);
  expect(history).toHaveBeenCalledTimes(1);
  await act(() => jest.advanceTimersByTimeAsync(55_000));
  expect(history).toHaveBeenCalledTimes(2);

  await fireEvent.press(screen.getByRole("button", { name: "Settings" }));
  const vitalsAtBlur = vitals.mock.calls.length;
  await act(() => jest.advanceTimersByTimeAsync(MINUTE));
  expect(vitals).toHaveBeenCalledTimes(vitalsAtBlur);
  expect(history).toHaveBeenCalledTimes(2);
});

test("updates status from transport events and pull to refresh retries only visible offline hosts", async () => {
  const transport = demo();
  const retry = jest.spyOn(transport, "retryRemoteHost");
  const list = jest.spyOn(transport, "listHosts");
  const vitals = jest.spyOn(transport, "hostVitals");
  const history = jest.spyOn(transport, "queryHistory");
  await renderHosts(transport, { removed: ["remote-nas"] });
  expect(
    await screen.findByRole("button", { name: /build, Linux, Live/ })
  ).toBeOnTheScreen();
  await act(() => {
    transport.pushRemoteStatus("remote-build", {
      state: "connecting",
      error: null,
    });
    transport.pushRemoteStatus("remote-nas", { state: "offline" });
  });
  expect(
    await screen.findByRole("button", { name: /build, Linux, Connecting/ })
  ).toBeOnTheScreen();
  vitals.mockClear();
  history.mockClear();
  await pullToRefresh();
  expect(
    await screen.findByRole("button", { name: /offline, Linux, Live/ })
  ).toBeOnTheScreen();
  expect(retry.mock.calls).toEqual([["remote-offline"]]);
  expect(list).toHaveBeenCalledTimes(2);
  expect(vitals).toHaveBeenCalledWith("remote-offline");
  expect(history).toHaveBeenCalledWith(
    expect.objectContaining({ host: "remote-offline" })
  );
});

test("uses integer epoch milliseconds even with a fractional monotonic clock", async () => {
  const transport = createMockTransport();
  const history = jest.spyOn(transport, "queryHistory");
  let elapsed = 0;
  jest.spyOn(performance, "now").mockImplementation(() => {
    elapsed += 0.161;
    return elapsed;
  });
  await renderHosts(transport);
  await waitFor(() => expect(history).toHaveBeenCalled());
  const request = history.mock.calls[0]?.[0];
  expect(Number.isInteger(request?.from_ms)).toBe(true);
  expect(Number.isInteger(request?.to_ms)).toBe(true);
});

test("describes the CPU sparkline in the host row's accessible name", async () => {
  await renderHosts(createMockTransport());
  expect(
    await screen.findByRole("button", {
      name: /MacBook Pro.*CPU history over the last 30 minutes/,
    })
  ).toBeOnTheScreen();
});

test("loads registry changes on return from a different screen", async () => {
  const transport = createMockTransport();
  const original = await transport.listHosts();
  const list = jest.spyOn(transport, "listHosts");
  await renderHosts(transport);
  expect(
    await screen.findByRole("button", { name: /MacBook Pro, macOS, Live/ })
  ).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole("button", { name: "Settings" }));
  list.mockResolvedValue(
    original.map((host) => ({ ...host, display_name: "Updated host" }))
  );
  await act(() => transport.emitHostsChanged());
  await act(() => router.back());
  expect(
    await screen.findByRole("button", { name: /Updated host, macOS, Live/ })
  ).toBeOnTheScreen();
});

test("retries a protocol-coded failure when the transport is still retrying", async () => {
  const transport = demo();
  const retry = jest.spyOn(transport, "retryRemoteHost");
  transport.pushRemoteStatus("remote-build", {
    state: "connecting",
    failure_kind: "protocol",
    error: "Codec error",
    last_seen_ms: NOW,
    clock_offset_ms: 0,
  });
  await renderHosts(transport);
  expect(
    await screen.findByRole("button", {
      name: /build, Linux, Offline since 14:00/,
    })
  ).toBeOnTheScreen();
  await pullToRefresh();
  expect(
    await screen.findByRole("button", { name: /build, Linux, Live/ })
  ).toBeOnTheScreen();
  expect(retry).toHaveBeenCalledWith("remote-build");
});

test("a failed status read replaces stale Live and explains the failure", async () => {
  const transport = demo();
  const listStatuses = jest.spyOn(transport, "listRemoteHosts");
  await renderHosts(transport);
  expect(
    await screen.findByRole("button", { name: /build, Linux, Live/ })
  ).toBeOnTheScreen();
  listStatuses.mockRejectedValue(new Error("Status endpoint unavailable."));
  await act(() =>
    transport.pushRemoteStatus("remote-build", { state: "offline" })
  );
  expect(
    await screen.findByRole(
      "button",
      { name: /build, Linux, Status unavailable.*Status endpoint unavailable/ },
      { timeout: 5_000 }
    )
  ).toBeOnTheScreen();
  expect(
    screen.queryByRole("button", { name: /build, Linux, Live/ })
  ).toBeNull();
});

test("offers the demo and pairing when the transport has no hosts", async () => {
  const transport = createMockTransport();
  jest.spyOn(transport, "listHosts").mockResolvedValue([]);
  await renderHosts(transport);
  expect(
    await screen.findByRole("header", { name: "No hosts yet" })
  ).toBeOnTheScreen();
  expect(
    screen.getByRole("button", { name: "Try demo hosts" })
  ).toBeOnTheScreen();
  await fireEvent.press(
    screen.getByRole("button", { name: "Pair with your Mac" })
  );
  expect(
    await screen.findByRole("header", { name: "Pairing screen" })
  ).toBeOnTheScreen();
});

test("shows a failed host read as an error and recovers on refresh", async () => {
  const transport = createMockTransport();
  jest
    .spyOn(transport, "listHosts")
    .mockRejectedValueOnce(new Error("Host registry unavailable."))
    .mockRejectedValueOnce(new Error("Host registry unavailable."));
  await renderHosts(transport);
  expect(
    await screen.findByRole(
      "alert",
      { name: /Host registry unavailable/ },
      { timeout: 5_000 }
    )
  ).toBeOnTheScreen();
  expect(screen.queryByRole("header", { name: "No hosts yet" })).toBeNull();
  await pullToRefresh();
  expect(
    await screen.findByRole("button", { name: /macOS, Live/ })
  ).toBeOnTheScreen();
});

test("redirects a direct hosts link to first launch before a transport is picked", async () => {
  await renderHosts();
  expect(
    await screen.findByRole("header", { name: "First launch" })
  ).toBeOnTheScreen();
});

test("shows missing readings as dashes", async () => {
  const transport = createMockTransport({ scenarios: ["host-unreachable"] });
  await renderHosts(transport);
  expect(
    await screen.findByRole("button", {
      name: /unreachable, Linux, Offline, CPU —, Memory —, Network —/,
    })
  ).toBeOnTheScreen();
});
