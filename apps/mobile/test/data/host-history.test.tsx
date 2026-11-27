import "react-native-gesture-handler/jestSetup";

import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { createMockTransport, type MockTransport } from "@core/mock-transport";
import { historyKeys } from "@core/query-keys";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "@core/time-grid";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { mockAppState } from "@test/helpers/mock-app-state";
import { renderWithProviders } from "@test/render";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { ExpoRoot, Stack } from "expo-router";
import { getMockContext } from "expo-router/build/testing-library/mock-config";
import { View } from "react-native";
import { useHostHistory } from "@/data/history";
import { ModuleScreen } from "@/module";
import { Text } from "@/ui/text";

function CoreHistory() {
  const query = useHostHistory(
    MOCK_HOST_ID,
    [
      { metric: "cpu.load", labels: [["core", "0"]] },
      { metric: "cpu.load", labels: [["core", "1"]] },
    ],
    { fromMs: now - HOUR_MS, toMs: now, rolling: false },
    { columns: 24 }
  );
  return (
    <Text variant="body">
      {query.data ? "Core history loaded" : "Loading cores…"}
    </Text>
  );
}

function EventFilters() {
  const series = [{ metric: "cpu.total", labels: [] }];
  const range = { fromMs: now - HOUR_MS, toMs: now, rolling: false } as const;
  const chart = useHostHistory(MOCK_HOST_ID, series, range, 300);
  const power = useHostHistory(MOCK_HOST_ID, series, range, 300, "power");
  return (
    <>
      {chart.data && (
        <Text variant="body">Chart events {chart.data.page.events.length}</Text>
      )}
      {power.data && (
        <Text variant="body">Power events {power.data.page.events.length}</Text>
      )}
    </>
  );
}

const context = getMockContext({
  _layout: () => <Stack />,
  "[host]/[module]": ModuleScreen,
  "[host]/heatmap": CoreHistory,
  "[host]/event-filters": EventFilters,
});
const now = Date.UTC(2026, 10, 25, 15);

function modulePage(host = MOCK_HOST_ID, module = "cpu") {
  return (
    <ExpoRoot
      context={context}
      location={new URL(`statglass:///${host}/${module}`)}
    />
  );
}

async function layout(width: number) {
  await fireEvent(screen.getByTestId("history-plot-layout"), "layout", {
    nativeEvent: { layout: { width } },
  });
}

async function selectWeek() {
  await fireEvent.press(
    screen.getByRole("tab", { name: "More, History range" })
  );
  await fireEvent.press(screen.getByRole("button", { name: "Last 7 days" }));
}

async function advanceWithFrames(transport: MockTransport, ms: number) {
  await act(async () => {
    for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
      await jest.advanceTimersByTimeAsync(Math.min(1000, ms - elapsed));
      transport.tick();
    }
  });
}

const warnings: unknown[][] = [];
beforeEach(() => {
  jest.useFakeTimers({ now });
  mockAppState();
  warnings.length = 0;
  jest.spyOn(console, "warn").mockImplementation((...args) => {
    warnings.push(args);
  });
});
afterEach(() => {
  jest.useRealTimers();
  expect(warnings).toEqual([]);
});

test("waits for chart layout, clamps the budget, and asks once per range or budget", async () => {
  const transport = createMockTransport({ autoTick: false });
  const read = jest
    .spyOn(transport, "hostHistory")
    .mockImplementation(async (request) => ({
      status: "ok",
      data: {
        tier: "m1",
        bucket_ms: MINUTE_MS,
        complete_to_ms: request.to_ms ?? request.from_ms,
        series: [],
        gaps: [],
        events: [],
        stats: [],
        clamped: [],
      },
    }));
  await renderWithProviders(modulePage(), { transport });
  await screen.findByRole("tab", { name: "15m, History range" });
  expect(read).not.toHaveBeenCalled();
  for (const [width, budget] of [
    [50, 30],
    [306, 122],
    [650, 200],
  ] as const) {
    await layout(width);
    expect(read).toHaveBeenLastCalledWith(
      expect.objectContaining({ max_points: budget })
    );
  }
  await layout(651);
  expect(read).toHaveBeenCalledTimes(3);
  await selectWeek();
  expect(read).toHaveBeenCalledTimes(4);
  const request = read.mock.calls.at(-1)?.[0];
  expect(request).toMatchObject({
    host: MOCK_HOST_ID,
    max_points: 200,
    events_for: "cpu",
    series: [
      { metric: "cpu.total", labels: [] },
      { metric: "cpu.system", labels: [] },
    ],
  });
  expect((request?.to_ms ?? 0) - (request?.from_ms ?? 0)).toBe(7 * DAY_MS);
});

test("per-core history asks for one point per heatmap column", async () => {
  const transport = createMockTransport({ autoTick: false });
  const read = jest.spyOn(transport, "hostHistory");
  await renderWithProviders(modulePage(MOCK_HOST_ID, "heatmap"), { transport });
  expect(await screen.findByText("Core history loaded")).toBeOnTheScreen();
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith({
    host: MOCK_HOST_ID,
    series: [
      { metric: "cpu.load", labels: [["core", "0"]] },
      { metric: "cpu.load", labels: [["core", "1"]] },
    ],
    from_ms: now - HOUR_MS,
    to_ms: now,
    max_points: 24,
    events_for: null,
  });
});

test("charts sharing series and bounds receive the events they each requested", async () => {
  const transport = createMockTransport({ autoTick: false });
  const read = jest.spyOn(transport, "hostHistory");
  await renderWithProviders(modulePage(MOCK_HOST_ID, "event-filters"), {
    transport,
  });
  expect(await screen.findByText("Chart events 0")).toBeOnTheScreen();
  expect(await screen.findByText("Power events 1")).toBeOnTheScreen();
  expect(read.mock.calls.map(([request]) => request.events_for)).toEqual([
    null,
    "power",
  ]);
});

test("a module remount reuses its reply for 30 seconds after it arrives and releases it after leaving", async () => {
  const transport = createMockTransport({ autoTick: false, latencyMs: 6_000 });
  const read = jest.spyOn(transport, "hostHistory");
  const view = await renderWithProviders(modulePage(), { transport });
  await screen.findByRole("tab", { name: "15m, History range" });
  await layout(300);
  await advanceWithFrames(transport, 12_500);
  await screen.findByText("No events in this range");
  expect(read).toHaveBeenCalledTimes(1);

  await view.rerender(<View />);
  await act(() => jest.advanceTimersByTimeAsync(20_000));
  await view.rerender(modulePage());
  await screen.findByRole("tab", { name: "15m, History range" });
  await layout(300);
  expect(screen.getByText("No events in this range")).toBeOnTheScreen();
  expect(read).toHaveBeenCalledTimes(1);

  await view.rerender(<View />);
  await act(() => jest.advanceTimersByTimeAsync(30_000));
  expect(
    view.client.getQueryCache().findAll({ queryKey: historyKeys.all })
  ).toEqual([]);
});

test("an in-flight reply cannot extend cache lifetime after the module leaves", async () => {
  const transport = createMockTransport({ autoTick: false, latencyMs: 10_000 });
  const read = jest.spyOn(transport, "hostHistory");
  const view = await renderWithProviders(modulePage(), { transport });
  await screen.findByRole("tab", { name: "15m, History range" });
  await layout(300);
  expect(read).toHaveBeenCalledTimes(1);
  await view.rerender(<View />);
  await act(() => jest.advanceTimersByTimeAsync(30_000));
  expect(
    view.client.getQueryCache().findAll({ queryKey: historyKeys.all })
  ).toEqual([]);
});

test("three busy replies keep loading until Retry can start a fresh round", async () => {
  const transport = createMockTransport({ autoTick: false });
  const read = jest.spyOn(transport, "hostHistory");
  for (let attempt = 0; attempt < 6; attempt++) {
    transport.failNext("hostHistory", { kind: "remote_busy", message: "busy" });
  }
  const [host] = await transport.listHosts();
  await renderWithProviders(modulePage(), { transport });
  await screen.findByRole("tab", { name: "15m, History range" });
  await layout(300);
  expect(read).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Loading history…")).toBeOnTheScreen();
  await act(() => jest.advanceTimersByTimeAsync(999));
  expect(read).toHaveBeenCalledTimes(1);
  await act(() => jest.advanceTimersByTimeAsync(1));
  expect(read).toHaveBeenCalledTimes(2);
  expect(screen.getByText("Loading history…")).toBeOnTheScreen();
  await act(() => jest.advanceTimersByTimeAsync(1000));
  expect(read).toHaveBeenCalledTimes(3);
  expect(
    await screen.findByText(`StatGlass on ${host?.display_name} is busy`)
  ).toBeOnTheScreen();
  expect(screen.queryByText("Loading history…")).not.toBeOnTheScreen();
  await fireEvent.press(screen.getByRole("button", { name: "Retry" }));
  expect(read).toHaveBeenCalledTimes(4);
  expect(await screen.findByText("Loading history…")).toBeOnTheScreen();
  await act(() => jest.advanceTimersByTimeAsync(1000));
  expect(read).toHaveBeenCalledTimes(5);
  expect(screen.getByText("Loading history…")).toBeOnTheScreen();
  await act(() => jest.advanceTimersByTimeAsync(1000));
  expect(
    await screen.findByText(`StatGlass on ${host?.display_name} is busy`)
  ).toBeOnTheScreen();
  expect(read).toHaveBeenCalledTimes(6);
  expect(screen.getByRole("button", { name: "Retry" })).toBeOnTheScreen();
});

test("a Busy reply schedules no history reads while the app is backgrounded", async () => {
  const setAppState = mockAppState();
  const transport = createMockTransport({ autoTick: false });
  const read = jest.spyOn(transport, "hostHistory");
  transport.failNext("hostHistory", { kind: "remote_busy", message: "busy" });
  await renderWithProviders(modulePage(), { transport });
  await screen.findByRole("tab", { name: "15m, History range" });
  await layout(300);
  expect(read).toHaveBeenCalledTimes(1);
  await setAppState("background");
  await act(() => jest.advanceTimersByTimeAsync(2000));
  expect(read).toHaveBeenCalledTimes(1);
  await setAppState("active");
  expect(await screen.findByText("No events in this range")).toBeOnTheScreen();
  expect(read).toHaveBeenCalledTimes(2);
});

test("Retry recovers an open chart after a transient history failure", async () => {
  const transport = createMockTransport({ autoTick: false });
  const read = jest.spyOn(transport, "hostHistory");
  transport.failNext("hostHistory", {
    kind: "remote_unreachable",
    message: "Connection dropped",
  });
  await renderWithProviders(modulePage(), { transport });
  await screen.findByRole("tab", { name: "15m, History range" });
  await layout(300);
  expect(
    await screen.findByText(
      "This host isn't connected, so its history can't be read now."
    )
  ).toBeOnTheScreen();
  expect(read).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("No events in this range")).toBeOnTheScreen();
  expect(read).toHaveBeenCalledTimes(2);
});

test("an unsupported host offers an update while its live CPU value changes", async () => {
  const transport = createMockTransport({ autoTick: false });
  const read = jest.spyOn(transport, "hostHistory");
  transport.failNext("hostHistory", {
    kind: "remote_unsupported",
    message: "history",
  });
  const [host] = await transport.listHosts();
  await renderWithProviders(modulePage(), { transport });
  await screen.findByRole("tab", { name: "15m, History range" });
  await layout(300);
  expect(
    await screen.findByText(
      `Update StatGlass on ${host?.display_name} to see history`
    )
  ).toBeOnTheScreen();
  await waitFor(() => expect(transport.subscriberCount()).toBe(1));
  const showCpu = (value: number) =>
    act(() =>
      transport.push({
        kind: "frame",
        layout_no: 99,
        timeline: 1,
        ts_ms: Date.now(),
        values: [value],
        held: [value],
      })
    );
  await act(() =>
    transport.push({
      kind: "layout",
      layout_no: 99,
      series: [{ metric: "cpu.total", labels: [] }],
      kinds: ["gauge"],
    })
  );
  await showCpu(37);
  expect(screen.getByLabelText("Total")).toHaveAccessibilityValue({
    text: "37%",
  });
  await act(() => jest.advanceTimersByTimeAsync(1000));
  await showCpu(59);
  expect(screen.getByLabelText("Total")).toHaveAccessibilityValue({
    text: "59%",
  });
  await act(() => transport.setPaused(true));
  expect(screen.getByLabelText("Total")).toHaveAccessibilityValue({
    text: "—",
  });
  expect(read).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "Retry" })).not.toBeOnTheScreen();
});

test("an offline host has no chart and makes no history request", async () => {
  const transport = createMockTransport({
    scenarios: ["hosts-dashboard"],
    autoTick: false,
  });
  const remote = (await transport.listRemoteHosts()).find(
    ({ status }) => status.state === "connected"
  );
  if (!remote) throw new Error("The demo needs a reachable host");
  transport.pushRemoteStatus(remote.config.id, {
    state: "offline",
    last_seen_ms: now - HOUR_MS,
  });
  const read = jest.spyOn(transport, "hostHistory");
  await renderWithProviders(modulePage(remote.config.id), { transport });
  expect(await screen.findByText(/^Offline since/)).toBeOnTheScreen();
  expect(
    screen.queryByRole("adjustable", { name: "CPU history" })
  ).not.toBeOnTheScreen();
  expect(read).not.toHaveBeenCalled();
});

test("keeps the selected range through reconnect and makes no history reads while connecting", async () => {
  const transport = createMockTransport({
    scenarios: ["hosts-dashboard"],
    autoTick: false,
  });
  const remote = (await transport.listRemoteHosts()).find(
    ({ status }) => status.state === "connected"
  );
  if (!remote) throw new Error("The demo needs a reachable host");
  const host = remote.config.id;
  const read = jest.spyOn(transport, "hostHistory");
  await renderWithProviders(modulePage(host), { transport });
  await screen.findByRole("tab", { name: "15m, History range" });
  await layout(300);
  const week = () => screen.getByRole("tab", { name: "7d, History range" });
  await selectWeek();
  await screen.findByText(/com\.docker\.backend at/);
  expect(read).toHaveBeenCalledTimes(2);

  await act(() => transport.pushRemoteStatus(host, { state: "connecting" }));
  expect(
    await screen.findByText(/^(Connecting|Reconnecting)/)
  ).toBeOnTheScreen();
  expect(week()).toBeSelected();
  await act(() => jest.advanceTimersByTimeAsync(MINUTE_MS));
  expect(read).toHaveBeenCalledTimes(2);

  await act(() => transport.pushRemoteStatus(host, { state: "connected" }));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  expect(week()).toBeSelected();
  const request = read.mock.calls.at(-1)?.[0];
  expect((request?.to_ms ?? 0) - (request?.from_ms ?? 0)).toBe(7 * DAY_MS);
});

test("a failed status refetch keeps the page and its selected range", async () => {
  const transport = createMockTransport({
    scenarios: ["hosts-dashboard"],
    autoTick: false,
    historyRows: 2,
  });
  const remote = (await transport.listRemoteHosts()).find(
    ({ status }) => status.state === "connected"
  );
  if (!remote) throw new Error("The demo needs a reachable host");
  const host = remote.config.id;
  await renderWithProviders(modulePage(host), { transport });
  await screen.findByRole("tab", { name: "15m, History range" });
  await layout(300);
  await selectWeek();
  await screen.findByText(/com\.docker\.backend at/);

  const list = jest.spyOn(transport, "listRemoteHosts");
  const unreadableStatus = {
    kind: "internal",
    message: "status read failed",
  } as const;
  transport.failNext("listRemoteHosts", unreadableStatus);
  transport.failNext("listRemoteHosts", unreadableStatus);
  await act(() => transport.pushRemoteStatus(host, { state: "connecting" }));
  await waitFor(() => expect(list).toHaveBeenCalled());
  await act(() => jest.advanceTimersByTimeAsync(1100));
  expect(
    await screen.findByRole("alert", {
      name: /Couldn’t read connection status/,
    })
  ).toBeOnTheScreen();
  expect(screen.getByRole("tab", { name: "7d, History range" })).toBeSelected();
  expect(screen.queryByText("Loading history…")).not.toBeOnTheScreen();
  expect(screen.getByRole("button", { name: "Retry" })).toBeOnTheScreen();
});

test.each(["unknown", "extension"] as const)(
  "waits for an active app when it starts in %s",
  async (initialState) => {
    const setAppState = mockAppState();
    await setAppState(initialState);
    const transport = createMockTransport({ autoTick: false });
    const read = jest.spyOn(transport, "hostHistory");
    const subscribe = jest.spyOn(transport, "subscribeLive");
    await renderWithProviders(modulePage(), { transport });
    await screen.findByRole("tab", { name: "15m, History range" });
    await layout(300);
    expect(read).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    await setAppState("active");
    expect(
      await screen.findByText("No events in this range")
    ).toBeOnTheScreen();
    expect(read).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
  }
);
