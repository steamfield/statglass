import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { phoneCommandFailures } from "@core/mock/phone-errors";
import { ok } from "@core/mock/protocol";
import { createMockTransport } from "@core/mock-transport";
import { CPU_HERO } from "@core/module-hero";
import { FULL_TABLE } from "@core/process-interest";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { mockAppState } from "@test/helpers/mock-app-state";
import { renderWithProviders } from "@test/render";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { ExpoRoot, router, Stack, useLocalSearchParams } from "expo-router";
import { getMockContext } from "expo-router/testing-library";
import { Dimensions, Text, View } from "react-native";
import { type ModuleRead, useModuleHistory } from "@/data/history";
import { useHostSparkline } from "@/data/host-sparkline";
import { useHostLiveSubscription } from "@/data/live";
import { useProcessDemand } from "@/data/processes";
import { HostScreen } from "@/host";
import { HostsList } from "@/hosts/hosts-list";
import { useModulePage } from "@/module/use-module-page";

const CPU_READ: ModuleRead = {
  module: "cpu",
  selection: CPU_HERO.keys.map((metric) => ({ metric, labels: [] })),
  gridKeys: CPU_HERO.keys,
};

function CpuModule() {
  const { host } = useLocalSearchParams<{ host: string }>();
  useHostLiveSubscription(host);
  const { range } = useModulePage(host, undefined);
  useModuleHistory(host, CPU_READ, range, 300, true);
  useProcessDemand(host, FULL_TABLE);
  return <Text>Live processes</Text>;
}

function Debug() {
  useHostLiveSubscription(MOCK_HOST_ID);
  return <Text>Diagnostics</Text>;
}

function Sparkline() {
  const chart = useHostSparkline(MOCK_HOST_ID);
  const points = chart.data?.series[0]?.values ?? [];
  return (
    <>
      <Text accessibilityLabel="Recent sparkline">
        {JSON.stringify(points.slice(-3))}
      </Text>
      <Text accessibilityLabel="First history buckets">
        {JSON.stringify(points.slice(0, 3))}
      </Text>
      <Text accessibilityLabel="Summary and history boundary">
        {JSON.stringify(points.slice(-8))}
      </Text>
    </>
  );
}

const routes = getMockContext({
  _layout: () => <Stack screenOptions={{ headerShown: false }} />,
  index: () => <View />,
  hosts: () => (
    <HostsList onDemo={jest.fn()} onOpen={jest.fn()} onPair={jest.fn()} />
  ),
  "[host]/index": HostScreen,
  "[host]/cpu": CpuModule,
  settings: () => <Text>Settings</Text>,
  debug: Debug,
  sparkline: Sparkline,
});

beforeEach(() => {
  jest.useFakeTimers({ now: Date.UTC(2026, 10, 25, 14) });
  mockAppState();
});

afterEach(() => {
  jest.useRealTimers();
});

test("pager demand follows the current host, clears in Settings and returns with focus", async () => {
  const transport = createMockTransport({
    scenarios: ["hosts-dashboard"],
    autoTick: false,
  });
  const [first, second] = await transport.listHosts();
  if (!first || !second) throw new Error("The demo needs two hosts");
  const send = jest.spyOn(transport, "setDemand");
  const process = jest.spyOn(transport, "setProcessInterest");
  await renderWithProviders(
    <ExpoRoot
      context={routes}
      location={new URL(`statglass:///${first.id}`)}
    />,
    { transport }
  );
  await waitFor(() =>
    expect(transport.demand()).toEqual([{ host: first.id, level: "full" }])
  );
  expect(send.mock.calls).toEqual([[[{ host: first.id, level: "full" }]]]);
  await fireEvent(screen.getByLabelText("Hosts pager"), "momentumScrollEnd", {
    nativeEvent: { contentOffset: { x: Dimensions.get("window").width, y: 0 } },
  });
  await waitFor(() =>
    expect(transport.demand()).toEqual([{ host: second.id, level: "full" }])
  );
  await act(() => router.push("/settings"));
  await waitFor(() => expect(transport.demand()).toEqual([]));
  await act(() => router.back());
  await waitFor(() =>
    expect(transport.demand()).toEqual([{ host: second.id, level: "full" }])
  );
  await act(() => router.push("/debug"));
  await waitFor(() => expect(transport.demand()).toEqual([]));
  expect(send.mock.calls).toEqual([
    [[{ host: first.id, level: "full" }]],
    [[{ host: second.id, level: "full" }]],
    [[]],
    [[{ host: second.id, level: "full" }]],
    [[]],
  ]);
  expect(process).not.toHaveBeenCalled();
});

test("a failed demand update is retried and releases the host after blur", async () => {
  const transport = createMockTransport({ autoTick: false });
  const send = jest.spyOn(transport, "setDemand");
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  await renderWithProviders(
    <ExpoRoot
      context={routes}
      location={new URL(`statglass:///${MOCK_HOST_ID}`)}
    />,
    { transport }
  );
  await waitFor(() =>
    expect(transport.demand()).toEqual([{ host: MOCK_HOST_ID, level: "full" }])
  );
  const interrupted = {
    kind: "internal",
    message: "Core queue interrupted",
  } as const;
  transport.failNext("setDemand", interrupted);
  transport.failNext("setDemand", interrupted);
  await act(() => router.push("/settings"));
  await waitFor(() => expect(transport.demand()).toEqual([]));
  expect(send.mock.calls).toEqual([
    [[{ host: MOCK_HOST_ID, level: "full" }]],
    [[]],
    [[]],
    [[]],
  ]);
});

test("the list replaces compact demand on scroll and reads one scoped history per visible host", async () => {
  const transport = createMockTransport({
    scenarios: ["hosts-dashboard"],
    autoTick: false,
  });
  const history = jest.spyOn(transport, "hostHistory");
  const send = jest.spyOn(transport, "setDemand");
  const [one, two] = (await transport.listHosts()).filter(
    ({ is_local, id }) => is_local || id === "remote-build"
  );
  if (!one || !two) throw new Error("The demo needs two connected hosts");
  await renderWithProviders(
    <ExpoRoot context={routes} location={new URL("statglass:///hosts")} />,
    { transport }
  );
  await screen.findByRole("button", { name: new RegExp(one.display_name) });
  expect(send).not.toHaveBeenCalled();
  expect(history).not.toHaveBeenCalled();
  const show = (...keys: string[]) =>
    fireEvent(screen.getByLabelText("Hosts list"), "viewableItemsChanged", {
      viewableItems: keys.map((key) => ({ key })),
    });
  await show(one.id);
  await waitFor(() =>
    expect(transport.demand()).toEqual([{ host: one.id, level: "compact" }])
  );
  await waitFor(() => expect(history).toHaveBeenCalledTimes(1));
  const first = history.mock.calls[0]?.[0];
  expect(first).toMatchObject({
    host: one.id,
    series: ["cpu.total", "mem.used", "net.rx_total", "net.tx_total"].map(
      (metric) => ({ metric, labels: [] })
    ),
    events_for: null,
  });
  if (!first || first.to_ms === null)
    throw new Error("Expected a bounded history query");
  expect(first.to_ms - first.from_ms).toBe(30 * 60_000);
  expect(first.max_points).toBeGreaterThanOrEqual(30);
  expect(first.max_points).toBeLessThanOrEqual(200);
  await act(() => jest.advanceTimersByTimeAsync(65_000));
  expect(history).toHaveBeenCalledTimes(1);
  const both = [one.id, two.id]
    .sort((a, b) => a.localeCompare(b))
    .map((host) => ({ host, level: "compact" }));
  await show(one.id, two.id);
  await waitFor(() => expect(transport.demand()).toEqual(both));
  await waitFor(() =>
    expect(history.mock.calls.map(([request]) => request.host)).toEqual([
      one.id,
      two.id,
    ])
  );
  await show(two.id);
  await waitFor(() =>
    expect(transport.demand()).toEqual([{ host: two.id, level: "compact" }])
  );
  expect(history).toHaveBeenCalledTimes(2);
  expect(send.mock.calls).toEqual([
    [[{ host: one.id, level: "compact" }]],
    [both],
    [[{ host: two.id, level: "compact" }]],
  ]);
});

function pushSummary(
  transport: ReturnType<typeof createMockTransport>,
  cpu: number
) {
  transport.push({
    kind: "layout",
    layout_no: 4,
    kinds: ["gauge"],
    series: [{ metric: "cpu.total", labels: [] }],
  });
  transport.push({
    kind: "frame",
    ts_ms: Date.now(),
    layout_no: 4,
    timeline: 1,
    values: [null],
    held: [cpu],
  });
}

test("a live process table owns interest for its stream until blur", async () => {
  const transport = createMockTransport({ autoTick: false });
  const process = jest.spyOn(transport, "setProcessInterest");
  await renderWithProviders(
    <ExpoRoot
      context={routes}
      location={new URL(`statglass:///${MOCK_HOST_ID}/cpu`)}
    />,
    { transport }
  );
  await waitFor(() =>
    expect(transport.demand()).toEqual([{ host: MOCK_HOST_ID, level: "full" }])
  );
  expect(process.mock.calls).toEqual([
    [MOCK_HOST_ID, true, FULL_TABLE, expect.any(Number)],
  ]);
  const stream = process.mock.calls[0]?.[3];
  await act(() => router.push("/settings"));
  await waitFor(() => expect(transport.demand()).toEqual([]));
  expect(process.mock.calls).toEqual([
    [MOCK_HOST_ID, true, FULL_TABLE, stream],
    [MOCK_HOST_ID, false, null, stream],
  ]);
});

test("an older host's sparkline grows from summaries and keeps a missed interval empty", async () => {
  const transport = createMockTransport({ autoTick: false });
  transport.failNext("hostHistory", {
    kind: "remote_unsupported",
    message: "No history feature",
  });
  const query = jest.spyOn(transport, "hostHistory");
  await renderWithProviders(
    <ExpoRoot context={routes} location={new URL("statglass:///sparkline")} />,
    { transport }
  );
  await waitFor(() => expect(query).toHaveBeenCalledTimes(1));
  expect(screen.getByLabelText("Recent sparkline")).toHaveTextContent("[]");
  await act(() => pushSummary(transport, 12));
  expect(screen.getByLabelText("Recent sparkline")).toHaveTextContent(
    "[null,null,12]"
  );
  await act(() => jest.advanceTimersByTimeAsync(10_000));
  await act(() => pushSummary(transport, 16));
  expect(screen.getByLabelText("Recent sparkline")).toHaveTextContent(
    "[12,null,16]"
  );
  expect(query).toHaveBeenCalledTimes(1);
});

test("keeps timed gaps and distinct summaries when extending a bounded history reply", async () => {
  const transport = createMockTransport({ autoTick: false });
  const baseline = Date.now();
  jest.spyOn(transport, "hostHistory").mockImplementation(async (request) =>
    ok({
      tier: "m1",
      bucket_ms: 60_000,
      complete_to_ms: baseline - 10_000,
      gaps: [],
      events: [],
      stats: [],
      clamped: [],
      series: [
        {
          key: { metric: "cpu.total", labels: [] },
          hold_ms: 60_000,
          points: [
            { t: request.from_ms, min: 11, max: 13, avg: 12 },
            { t: request.from_ms + 120_000, min: 15, max: 17, avg: 16 },
            { t: request.from_ms + 29 * 60_000, min: 23, max: 25, avg: 24 },
          ],
        },
      ],
    })
  );
  await renderWithProviders(
    <ExpoRoot context={routes} location={new URL("statglass:///sparkline")} />,
    { transport }
  );
  await waitFor(() =>
    expect(screen.getByLabelText("First history buckets")).toHaveTextContent(
      "[12,null,16]"
    )
  );
  await act(() => {
    jest.setSystemTime(baseline + 1_000);
    pushSummary(transport, 31);
    jest.setSystemTime(baseline + 2_000);
    pushSummary(transport, 32);
    jest.setSystemTime(baseline + 20_000);
    pushSummary(transport, 33);
  });
  expect(
    screen.getByLabelText("Summary and history boundary")
  ).toHaveTextContent("[24,null,31,32,null,null,null,33]");
});

test("row history recovers from a transient connection failure", async () => {
  const transport = createMockTransport({
    scenarios: ["phone-sparkline-gap"],
    autoTick: false,
  });
  transport.failNext("hostHistory", phoneCommandFailures.retryNetwork);
  const history = jest.spyOn(transport, "hostHistory");
  await renderWithProviders(
    <ExpoRoot context={routes} location={new URL("statglass:///sparkline")} />,
    { transport }
  );
  await waitFor(() => expect(history).toHaveBeenCalledTimes(1));
  expect(screen.getByLabelText("First history buckets")).toHaveTextContent(
    "[]"
  );
  await act(() => jest.advanceTimersByTimeAsync(1_000));
  await waitFor(() =>
    expect(screen.getByLabelText("First history buckets")).toHaveTextContent(
      "[12,null,16]"
    )
  );
  expect(history).toHaveBeenCalledTimes(2);
});

test("a visible row recovers its summary subscription and updates readings and history while Live", async () => {
  const transport = createMockTransport({ autoTick: false });
  transport.failNext("subscribeLive", phoneCommandFailures.retryNetwork);
  transport.failNext("hostHistory", {
    kind: "remote_unsupported",
    message: "No history feature",
  });
  const subscribe = jest.spyOn(transport, "subscribeLive");
  await renderWithProviders(
    <ExpoRoot context={routes} location={new URL("statglass:///hosts")} />,
    { transport }
  );
  await screen.findByLabelText("Hosts list");
  await fireEvent(screen.getByLabelText("Hosts list"), "viewableItemsChanged", {
    viewableItems: [{ key: MOCK_HOST_ID }],
  });
  await screen.findByRole("button", { name: /Live, CPU 18%/ });
  expect(subscribe).toHaveBeenCalledTimes(1);
  await act(() => jest.advanceTimersByTimeAsync(5_000));
  expect(subscribe).toHaveBeenCalledTimes(2);
  await act(() => pushSummary(transport, 34));
  await screen.findByRole("button", { name: /Live, CPU 34%.*CPU history/ });
  await act(() => jest.advanceTimersByTimeAsync(5_000));
  await act(() => pushSummary(transport, 42));
  await screen.findByRole("button", { name: /Live, CPU 42%.*CPU history/ });
});
