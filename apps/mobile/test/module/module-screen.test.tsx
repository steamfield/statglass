import "react-native-gesture-handler/jestSetup";

import { eventLabel } from "@core/events";
import { formatClockSeconds, formatHistoryTime } from "@core/format";
import type {
  Event,
  HostHistoryPage,
  HostHistoryRequest,
} from "@core/generated/types";
import { historyGrid } from "@core/history-grid";
import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { createMockTransport, type MockTransport } from "@core/mock-transport";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "@core/time-grid";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import { ExpoRoot, Stack } from "expo-router";
import { getMockContext } from "expo-router/build/testing-library/mock-config";
import { AppState } from "react-native";
import { createGestureController } from "react-native-gesture-handler/jest-utils";
import { ModuleScreen } from "@/module";
import { historyChart } from "@/module/history-chart";

jest.mock("react-native-worklets", () =>
  jest.requireActual("react-native-worklets/src/mock")
);

const context = getMockContext({
  _layout: () => <Stack screenOptions={{ headerShown: false }} />,
  "[host]/[module]": ModuleScreen,
});
const now = Date.UTC(2026, 10, 24, 15, 2);
const record: Event = {
  ts_ms: now - MINUTE_MS,
  start_ms: now - MINUTE_MS,
  detail: {
    kind: "sustained_process",
    process: "kernel_task",
    cpu_pct: 80,
    secs: 30,
  },
  processes: ["kernel_task"],
};

beforeEach(() => {
  jest.useFakeTimers({ now });
});

afterEach(() => {
  jest.useRealTimers();
});

function openModule(host = MOCK_HOST_ID, module = "cpu") {
  return (
    <ExpoRoot
      context={context}
      location={new URL(`statglass:///${host}/${module}`)}
    />
  );
}

function emptyPage(
  request: HostHistoryRequest,
  events: Event[] = []
): HostHistoryPage {
  return {
    tier: "m1",
    bucket_ms: MINUTE_MS,
    complete_to_ms: request.to_ms ?? request.from_ms,
    series: [],
    gaps: [],
    events,
    stats: [],
    clamped: [],
  };
}

type Read = MockTransport["hostHistory"];

function observeHistory(transport: MockTransport, answer?: Read) {
  const read = jest.spyOn(transport, "hostHistory");
  if (answer) read.mockImplementation(answer);
  return { read, charts: () => read.mock.calls.map(([request]) => request) };
}

async function layoutPlot() {
  await fireEvent(await screen.findByTestId("history-plot-layout"), "layout", {
    nativeEvent: { layout: { width: 300 } },
  });
}

const eventsReply =
  (events: Event[]): Read =>
  async (request) => ({
    status: "ok",
    data: emptyPage(request, events),
  });

function cpuPage(request: HostHistoryRequest): HostHistoryPage {
  const { series, from_ms } = request;
  return {
    ...emptyPage(request),
    gaps: [
      {
        start_ms: from_ms + MINUTE_MS,
        end_ms: from_ms + 2 * MINUTE_MS,
        module: null,
        reason: "paused",
      },
    ],
    series: [
      {
        key: series[0] ?? { metric: "cpu.total", labels: [] },
        hold_ms: 0,
        points: [
          { t: from_ms, min: 21, avg: 30, max: 39 },
          { t: from_ms + MINUTE_MS, min: 40, avg: 50, max: 60 },
        ],
      },
    ],
  };
}

test("history chart passes the missing bucket, gap band, and trailing event to the twin", () => {
  const fromMs = now - 3 * MINUTE_MS;
  const toMs = now - 1000;
  const key = { metric: "cpu.total", labels: [] };
  const data = cpuPage({
    host: MOCK_HOST_ID,
    series: [key],
    from_ms: fromMs,
    to_ms: toMs,
    events_for: null,
    max_points: 10,
  });
  const grid = historyGrid(data, [key.metric], fromMs, toMs);
  const lateEvent = { ...record, ts_ms: toMs - 500 };
  const { chart, sampleCount } = historyChart(
    "cpu",
    { fromMs, toMs },
    { data, grid, isPending: false },
    [lateEvent]
  );
  expect(sampleCount).toBe(3);
  expect(chart.series).toEqual([
    { key: key.metric, step: 1, values: [30, null, null, null] },
  ]);
  expect(chart.gaps).toMatchObject([
    {
      fromMs: fromMs + MINUTE_MS,
      toMs: fromMs + 2 * MINUTE_MS,
      label: "Recording paused here",
    },
  ]);
  expect(chart.annotations).toEqual([
    { tsMs: lateEvent.ts_ms, label: eventLabel(record) },
  ]);
  expect(chart.height).toBe(160);
});

test("range tabs ask once per range for chart history and show its dated events", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const history = observeHistory(transport, eventsReply([record]));
  await renderWithProviders(openModule(), { transport });
  await layoutPlot();

  expect(await screen.findAllByRole("tab")).toHaveLength(4);
  expect(screen.getByText("24 h")).toBeOnTheScreen();
  expect(screen.getByRole("tab", { name: "Last 1 hour" })).toBeSelected();
  expect(await screen.findByText(eventLabel(record))).toBeOnTheScreen();
  expect(screen.getByText(formatClockSeconds(record.ts_ms))).toBeOnTheScreen();

  const ranges = [
    ["Last 1 day", DAY_MS],
    ["Last 7 days", 7 * DAY_MS],
    ["Last 30 days", 30 * DAY_MS],
  ] as const;
  for (const [index, [label, duration]] of ranges.entries()) {
    await fireEvent.press(screen.getByRole("tab", { name: label }));
    expect(screen.getByRole("tab", { name: label })).toBeSelected();
    expect(history.charts()).toHaveLength(index + 2);
    const request = history.charts().at(-1);
    if (!request || request.to_ms === null)
      throw new Error("History request did not include an end");
    expect(request.to_ms - request.from_ms).toBe(duration);
    expect(request).toMatchObject({
      host: MOCK_HOST_ID,
      series: [{ metric: "cpu.total", labels: [] }],
      events_for: "cpu",
    });
  }
  expect(
    await screen.findByText(formatHistoryTime(record.ts_ms, true))
  ).toBeOnTheScreen();
});

test("scrubbing reads the selected bucket, a long press pins a gap and plays a haptic", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const history = observeHistory(transport, async (request) => ({
    status: "ok",
    data: cpuPage(request),
  }));
  const selection = jest
    .spyOn(Haptics, "selectionAsync")
    .mockResolvedValue(undefined);
  await renderWithProviders(openModule(), { transport });
  await layoutPlot();
  await waitFor(() =>
    expect(screen.queryByText("Loading history…")).not.toBeOnTheScreen()
  );
  const chart = screen.getByRole("adjustable", { name: "CPU history" });
  const from = history.charts().at(-1)?.from_ms ?? now - HOUR_MS;
  await fireEvent(chart, "layout", { nativeEvent: { layout: { width: 300 } } });
  const pan = createGestureController("history-pan");
  await act(() => {
    pan.begin({ x: 0 });
    pan.activate({ x: 0 });
  });
  expect(screen.getByText("30%")).toBeOnTheScreen();
  expect(screen.getByText(formatClockSeconds(from))).toBeOnTheScreen();
  await act(() => pan.end());
  expect(screen.queryByText("30%")).not.toBeOnTheScreen();

  const longPress = createGestureController("history-pin");
  await act(() => {
    longPress.begin({ x: 5 });
    longPress.activate({ x: 5 });
    longPress.end();
  });
  expect(selection).toHaveBeenCalledTimes(1);
  expect(screen.getByText("No samples")).toBeOnTheScreen();
  expect(
    screen.getByText(formatClockSeconds(from + MINUTE_MS))
  ).toBeOnTheScreen();
  expect(chart).toHaveAccessibilityValue({
    text: `${formatClockSeconds(from + MINUTE_MS)}, No samples`,
  });
  await fireEvent.press(screen.getByRole("button", { name: "Clear pin" }));
  expect(screen.queryByText("No samples")).not.toBeOnTheScreen();
});

test("loading resolves to explicit empty history and events", async () => {
  const transport = createMockTransport({
    autoTick: false,
    historyRows: 0,
    latencyMs: 500,
  });
  observeHistory(transport, async (request) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return { status: "ok", data: emptyPage(request) };
  });
  await renderWithProviders(openModule(), { transport });
  await layoutPlot();
  expect(screen.getByText("Loading history…")).toBeOnTheScreen();
  expect(await screen.findByText("No samples in this range")).toBeOnTheScreen();
  expect(screen.getByText("No events in this range")).toBeOnTheScreen();
});

test("the ceiling sits outside the plot and VoiceOver double-tap pins and clears", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  observeHistory(transport, async (request) => ({
    status: "ok",
    data: cpuPage(request),
  }));
  const selection = jest
    .spyOn(Haptics, "selectionAsync")
    .mockResolvedValue(undefined);
  await renderWithProviders(openModule(), { transport });
  await layoutPlot();
  const plot = await screen.findByRole("adjustable", { name: "CPU history" });
  expect(screen.getByText("100%")).toBeOnTheScreen();
  await waitFor(() =>
    expect(screen.queryByText("Loading history…")).not.toBeOnTheScreen()
  );
  await fireEvent(plot, "accessibilityTap");
  expect(screen.getByRole("button", { name: "Clear pin" })).toBeOnTheScreen();
  expect(selection).toHaveBeenCalledTimes(1);
  await fireEvent(plot, "accessibilityTap");
  expect(
    screen.queryByRole("button", { name: "Clear pin" })
  ).not.toBeOnTheScreen();
});

test("the right edge pins the last returned bucket time within the requested window", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const history = observeHistory(transport, async (request) => ({
    status: "ok",
    data: cpuPage(request),
  }));
  jest.spyOn(Haptics, "selectionAsync").mockResolvedValue(undefined);
  await renderWithProviders(openModule(), { transport });
  await layoutPlot();
  const plot = await screen.findByRole("adjustable", { name: "CPU history" });
  await waitFor(() =>
    expect(screen.queryByText("Loading history…")).not.toBeOnTheScreen()
  );
  const request = history.charts().at(-1);
  if (!request || request.to_ms === null)
    throw new Error("History request did not include an end");
  await fireEvent(plot, "accessibilityAction", {
    nativeEvent: { actionName: "activate" },
  });
  expect(plot).toHaveAccessibilityValue({
    text: `${formatClockSeconds(request.to_ms - MINUTE_MS)}, No samples`,
  });
});

test("a foreground module refreshes both history and events as time advances", async () => {
  const initialAppState = AppState.currentState;
  AppState.currentState = "active";
  const listener = jest
    .spyOn(AppState, "addEventListener")
    .mockReturnValue({ remove: () => {} });
  try {
    const transport = createMockTransport({ autoTick: false, historyRows: 2 });
    const history = observeHistory(transport);
    const view = await renderWithProviders(openModule(), { transport });
    await layoutPlot();
    await waitFor(() => expect(history.charts()).toHaveLength(1));
    const end = history.charts().at(-1)?.to_ms ?? 0;
    const emitAppState = (state: "background" | "active") => {
      AppState.currentState = state;
      for (const [event, onChange] of listener.mock.calls) {
        if (event === "change") onChange(state);
      }
    };
    await act(() => emitAppState("background"));
    await act(() => jest.advanceTimersByTimeAsync(2 * MINUTE_MS));
    expect(history.charts()).toHaveLength(1);
    await act(() => emitAppState("active"));
    await waitFor(() => expect(history.charts()).toHaveLength(2));
    expect(history.charts().at(-1)?.to_ms).toBeGreaterThanOrEqual(
      end + 2 * MINUTE_MS
    );
    expect(history.charts().at(-1)?.events_for).toBe("cpu");
    await act(() => jest.advanceTimersByTimeAsync(MINUTE_MS));
    expect(history.charts()).toHaveLength(3);
    await view.unmount();
  } finally {
    AppState.currentState = initialAppState;
  }
});

test("a minute refresh keeps plotted samples, event rows, and the pinned reading while the reply is pending", async () => {
  const initialAppState = AppState.currentState;
  AppState.currentState = "active";
  try {
    const transport = createMockTransport({ autoTick: false, historyRows: 2 });
    const history = observeHistory(transport, async (request) => ({
      status: "ok",
      data: {
        ...cpuPage(request),
        events: [record],
        series: [
          {
            key: { metric: "cpu.total", labels: [] },
            hold_ms: 0,
            points: [
              {
                t: request.from_ms,
                min: 29,
                avg: 30,
                max: 31,
              },
            ],
          },
        ],
      },
    }));
    jest.spyOn(Haptics, "selectionAsync").mockResolvedValue(undefined);
    const view = await renderWithProviders(openModule(), { transport });
    await layoutPlot();
    try {
      expect(await screen.findByText(eventLabel(record))).toBeOnTheScreen();
      await waitFor(() =>
        expect(screen.queryByText("Loading history…")).not.toBeOnTheScreen()
      );
      const plot = () =>
        screen.getByRole("adjustable", { name: "CPU history" });
      const request = history.charts().at(-1);
      if (!request) throw new Error("History request did not run");
      const value = { text: `${formatClockSeconds(request.from_ms)}, 30%` };
      await fireEvent(plot(), "layout", {
        nativeEvent: { layout: { width: 300 } },
      });
      const pin = createGestureController("history-pin");
      await act(() => {
        pin.begin({ x: 0 });
        pin.activate({ x: 0 });
        pin.end();
      });
      expect(plot()).toHaveAccessibilityValue(value);

      history.read.mockImplementation(() => new Promise<never>(() => {}));
      await act(() => jest.advanceTimersByTimeAsync(MINUTE_MS));
      expect(history.charts()).toHaveLength(2);
      expect(screen.queryByText("Loading history…")).not.toBeOnTheScreen();
      expect(screen.getByText(eventLabel(record))).toBeOnTheScreen();
      expect(
        screen.getByRole("button", { name: "Clear pin" })
      ).toBeOnTheScreen();
      expect(plot()).toHaveAccessibilityValue(value);

      await fireEvent.press(screen.getByRole("tab", { name: "Last 7 days" }));
      expect(screen.getByText("Loading history…")).toBeOnTheScreen();
      expect(screen.queryByText(eventLabel(record))).not.toBeOnTheScreen();
    } finally {
      await view.unmount();
    }
  } finally {
    AppState.currentState = initialAppState;
  }
});

test("a failed remote status read explains why the module cannot load", async () => {
  const transport = createMockTransport({
    scenarios: ["hosts-dashboard"],
    autoTick: false,
    historyRows: 2,
  });
  const [remote] = await transport.listRemoteHosts();
  if (!remote) throw new Error("The demo needs a remote host");
  jest.spyOn(transport, "listRemoteHosts").mockRejectedValue({
    kind: "remote_unreachable",
    message: "Network unavailable",
  });
  const history = jest.spyOn(transport, "hostHistory");
  await renderWithProviders(openModule(remote.config.id), { transport });
  expect(
    await screen.findByRole(
      "alert",
      {
        name: "This host isn't connected, so its connection status can't be read now.",
      },
      { timeout: 2000 }
    )
  ).toBeOnTheScreen();
  expect(history).not.toHaveBeenCalled();
});

test("offline history ends at the mirror watermark and shows the offline and sync times", async () => {
  const transport = createMockTransport({
    scenarios: ["hosts-dashboard"],
    autoTick: false,
    historyRows: 2,
  });
  const remote = (await transport.listRemoteHosts()).find(
    ({ status }) => status.state === "connected"
  );
  if (!remote) throw new Error("The demo needs a connected remote");
  const from = now - 5 * MINUTE_MS;
  const end = from - MINUTE_MS;
  transport.pushRemoteStatus(remote.config.id, {
    state: "offline",
    last_seen_ms: from,
    synced_through_ms: end,
  });
  const history = observeHistory(transport);
  await renderWithProviders(openModule(remote.config.id), { transport });
  expect(await screen.findByText(/Offline since/)).toBeOnTheScreen();
  expect(screen.getByText(/Last synced through/)).toBeOnTheScreen();
  expect(history.charts().at(-1)?.to_ms).toBe(end);
});

test("network identifies both series before scrubbing and history mounts only visible event rows", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const events = Array.from(
    { length: 60 },
    (_, index) =>
      ({
        ...record,
        ts_ms: record.ts_ms + index * 1000,
        detail: {
          kind: "alert",
          rule_id: "network-download",
          rule_name: "Download",
          cause: {
            type: "threshold",
            metric: "net.rx_total",
            labels: [],
            value: index,
            op: "gt",
            threshold: 0,
            for_secs: 0,
          },
        },
      }) satisfies Event
  );
  observeHistory(transport, eventsReply(events));
  await renderWithProviders(openModule(MOCK_HOST_ID, "network"), { transport });
  await layoutPlot();
  const first = events.at(0);
  const last = events.at(-1);
  if (!first || !last) throw new Error("The event list needs two endpoints");
  expect(await screen.findByText(eventLabel(last))).toBeOnTheScreen();
  expect(screen.queryByText(eventLabel(first))).not.toBeOnTheScreen();
  expect(screen.getByText("Download")).toBeOnTheScreen();
  expect(screen.getByText("Upload")).toBeOnTheScreen();
});

test("the first query for a skewed remote uses its host clock for history and events", async () => {
  const transport = createMockTransport({
    scenarios: ["hosts-dashboard"],
    autoTick: false,
    historyRows: 2,
  });
  const remote = (await transport.listRemoteHosts()).find(
    ({ status }) =>
      status.state === "connected" && (status.clock_offset_ms ?? 0) > 0
  );
  if (!remote) throw new Error("The demo needs a host with clock skew");
  const history = observeHistory(transport);
  await renderWithProviders(openModule(remote.config.id), { transport });
  await layoutPlot();
  await waitFor(() => expect(history.charts()).toHaveLength(1));
  const request = history.charts().at(-1);
  if (!request || request.to_ms === null)
    throw new Error("History request did not include an end");
  expect(request.to_ms - now).toBeGreaterThanOrEqual(
    remote.status.clock_offset_ms ?? 0
  );
  expect(request.to_ms - now).toBeLessThan(
    (remote.status.clock_offset_ms ?? 0) + 1000
  );
  expect(request).toMatchObject({ host: remote.config.id, events_for: "cpu" });
});

test("reports a locked history store once for the shared reply", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  observeHistory(transport, async () => ({
    status: "error",
    error: { kind: "history_unavailable", reason: { kind: "locked" } },
  }));
  await renderWithProviders(openModule(), { transport });
  await layoutPlot();
  expect(
    await screen.findByText(
      /another copy of StatGlass has the history file open/,
      {},
      { timeout: 2000 }
    )
  ).toBeOnTheScreen();
  expect(
    screen.getAllByText(/another copy of StatGlass has the history file open/)
  ).toHaveLength(1);
  expect(screen.queryByText("No events in this range")).not.toBeOnTheScreen();
});

test("an unsupported module link gives an unavailable state without reading history", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const read = jest.spyOn(transport, "hostHistory");
  await renderWithProviders(openModule(MOCK_HOST_ID, "disk"), { transport });
  expect(screen.getByText("This module isn’t available.")).toBeOnTheScreen();
  expect(read).not.toHaveBeenCalled();
});
