import "react-native-gesture-handler/jestSetup";

import { formatClockSeconds, formatHistoryTime } from "@core/format";
import type { Event, HistoryPage, HistoryRequest } from "@core/generated/types";
import { historyGrid } from "@core/history-grid";
import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { createMockTransport } from "@core/mock-transport";
import { historyKeys } from "@core/query-keys";
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
jest.mock("react-native-reanimated", () =>
  jest.requireActual("react-native-reanimated/mock")
);

const context = getMockContext({
  _layout: () => <Stack screenOptions={{ headerShown: false }} />,
  "[host]/[module]": ModuleScreen,
});
const now = Date.UTC(2026, 10, 24, 15, 2);
const record: Event = {
  ts_ms: now - MINUTE_MS,
  start_ms: now - MINUTE_MS,
  detail: { kind: "fans_ramped", from_rpm: 0, to_rpm: 2000 },
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

function cpuPage({ selectors, from_ms }: HistoryRequest): HistoryPage {
  return {
    tier: "m1",
    bucket_ms: MINUTE_MS,
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
        key: selectors[0] ?? { metric: "cpu.total", labels: [] },
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
    selectors: [key],
    from_ms: fromMs,
    to_ms: toMs,
    tier: "auto",
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
    { tsMs: lateEvent.ts_ms, label: "Fans ramped up · kernel_task" },
  ]);
  expect(chart.height).toBe(160);
});

test("range tabs select new history and event keys with the same bounds and show dated events", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  transport.recordEvent(record);
  const readHistory = jest.spyOn(transport, "queryHistory");
  const readEvents = jest.spyOn(transport, "queryEvents");
  const { client } = await renderWithProviders(openModule(), { transport });

  expect(await screen.findAllByRole("tab")).toHaveLength(4);
  expect(screen.getByText("24 h")).toBeOnTheScreen();
  expect(screen.getByRole("tab", { name: "Last 1 hour" })).toBeSelected();
  expect(
    await screen.findByText("Fans ramped up · kernel_task")
  ).toBeOnTheScreen();
  expect(screen.getByText(formatClockSeconds(record.ts_ms))).toBeOnTheScreen();

  for (const [label, duration] of [
    ["Last 1 day", DAY_MS],
    ["Last 7 days", 7 * DAY_MS],
    ["Last 30 days", 30 * DAY_MS],
  ] as const) {
    await fireEvent.press(screen.getByRole("tab", { name: label }));
    expect(screen.getByRole("tab", { name: label })).toBeSelected();
    await waitFor(() =>
      expect(readHistory.mock.lastCall?.[0]).toMatchObject({
        host: MOCK_HOST_ID,
        selectors: [{ metric: "cpu.total", labels: [] }],
      })
    );
    const request = readHistory.mock.lastCall?.[0];
    if (!request) throw new Error("History request did not run");
    expect(request.to_ms - request.from_ms).toBe(duration);
    expect(readEvents.mock.lastCall).toEqual([
      MOCK_HOST_ID,
      request.from_ms,
      request.to_ms,
    ]);
    expect(
      client.getQueryState(
        historyKeys.moduleSeries(
          MOCK_HOST_ID,
          ["cpu.total"],
          duration,
          request.to_ms,
          request.max_points
        )
      )
    ).toBeDefined();
    expect(
      client.getQueryState(
        historyKeys.events(MOCK_HOST_ID, duration, request.to_ms)
      )
    ).toBeDefined();
  }
  expect(
    await screen.findByText(formatHistoryTime(record.ts_ms, true))
  ).toBeOnTheScreen();
});

test("scrubbing reads the selected bucket, a long press pins a gap and plays a haptic", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const readHistory = jest
    .spyOn(transport, "queryHistory")
    .mockImplementation(async (request) => ({
      status: "ok",
      data: cpuPage(request),
    }));
  const selection = jest
    .spyOn(Haptics, "selectionAsync")
    .mockResolvedValue(undefined);
  await renderWithProviders(openModule(), { transport });
  await waitFor(() =>
    expect(screen.queryByText("Loading history…")).not.toBeOnTheScreen()
  );
  const chart = screen.getByRole("adjustable", { name: "CPU history" });
  const from = readHistory.mock.lastCall?.[0].from_ms ?? now - HOUR_MS;
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
  jest.spyOn(transport, "queryHistory").mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return {
      status: "ok",
      data: { tier: "m1", bucket_ms: MINUTE_MS, series: [], gaps: [] },
    };
  });
  jest
    .spyOn(transport, "queryEvents")
    .mockResolvedValue({ status: "ok", data: [] });
  await renderWithProviders(openModule(), { transport });
  expect(screen.getByText("Loading history…")).toBeOnTheScreen();
  expect(await screen.findByText("No samples in this range")).toBeOnTheScreen();
  expect(screen.getByText("No events in this range")).toBeOnTheScreen();
});

test("the ceiling sits outside the plot and VoiceOver double-tap pins and clears", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  jest.spyOn(transport, "queryHistory").mockImplementation(async (request) => ({
    status: "ok",
    data: cpuPage(request),
  }));
  const selection = jest
    .spyOn(Haptics, "selectionAsync")
    .mockResolvedValue(undefined);
  await renderWithProviders(openModule(), { transport });
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
  const query = jest
    .spyOn(transport, "queryHistory")
    .mockImplementation(async (request) => ({
      status: "ok",
      data: cpuPage(request),
    }));
  jest.spyOn(Haptics, "selectionAsync").mockResolvedValue(undefined);
  await renderWithProviders(openModule(), { transport });
  const plot = await screen.findByRole("adjustable", { name: "CPU history" });
  await waitFor(() =>
    expect(screen.queryByText("Loading history…")).not.toBeOnTheScreen()
  );
  const request = query.mock.lastCall?.[0];
  if (!request) throw new Error("History request did not run");
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
    const query = jest.spyOn(transport, "queryHistory");
    const events = jest.spyOn(transport, "queryEvents");
    const view = await renderWithProviders(openModule(), { transport });
    await waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    const end = query.mock.lastCall?.[0].to_ms ?? 0;
    const emitAppState = (state: "background" | "active") => {
      AppState.currentState = state;
      for (const [event, onChange] of listener.mock.calls) {
        if (event === "change") onChange(state);
      }
    };
    await act(() => emitAppState("background"));
    await act(() => jest.advanceTimersByTimeAsync(2 * MINUTE_MS));
    expect(query).toHaveBeenCalledTimes(1);
    await act(() => emitAppState("active"));
    await waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    expect(query.mock.lastCall?.[0].to_ms).toBeGreaterThanOrEqual(
      end + 2 * MINUTE_MS
    );
    expect(events.mock.lastCall?.[2]).toBe(query.mock.lastCall?.[0].to_ms);
    await act(() => jest.advanceTimersByTimeAsync(MINUTE_MS));
    expect(query).toHaveBeenCalledTimes(3);
    await view.unmount();
  } finally {
    AppState.currentState = initialAppState;
  }
});

test("a minute refresh keeps the plotted samples, event rows, and pinned reading while both reads are pending", async () => {
  const initialAppState = AppState.currentState;
  AppState.currentState = "active";
  try {
    const transport = createMockTransport({ autoTick: false, historyRows: 2 });
    const history = jest
      .spyOn(transport, "queryHistory")
      .mockImplementation(async (request) => ({
        status: "ok",
        data: {
          ...cpuPage(request),
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
    const events = jest
      .spyOn(transport, "queryEvents")
      .mockResolvedValue({ status: "ok", data: [record] });
    jest.spyOn(Haptics, "selectionAsync").mockResolvedValue(undefined);
    const view = await renderWithProviders(openModule(), { transport });
    try {
      expect(
        await screen.findByText("Fans ramped up · kernel_task")
      ).toBeOnTheScreen();
      await waitFor(() =>
        expect(screen.queryByText("Loading history…")).not.toBeOnTheScreen()
      );
      const plot = () =>
        screen.getByRole("adjustable", { name: "CPU history" });
      const request = history.mock.lastCall?.[0];
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

      history.mockImplementation(() => new Promise<never>(() => {}));
      events.mockImplementation(() => new Promise<never>(() => {}));
      await act(() => jest.advanceTimersByTimeAsync(MINUTE_MS));
      expect(history).toHaveBeenCalledTimes(2);
      expect(events).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("Loading history…")).not.toBeOnTheScreen();
      expect(
        screen.getByText("Fans ramped up · kernel_task")
      ).toBeOnTheScreen();
      expect(
        screen.getByRole("button", { name: "Clear pin" })
      ).toBeOnTheScreen();
      expect(plot()).toHaveAccessibilityValue(value);

      await fireEvent.press(screen.getByRole("tab", { name: "Last 7 days" }));
      expect(screen.getByText("Loading history…")).toBeOnTheScreen();
      expect(
        screen.queryByText("Fans ramped up · kernel_task")
      ).not.toBeOnTheScreen();
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
  const history = jest.spyOn(transport, "queryHistory");
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
  const query = jest.spyOn(transport, "queryHistory");
  await renderWithProviders(openModule(remote.config.id), { transport });
  expect(await screen.findByText(/Offline since/)).toBeOnTheScreen();
  expect(screen.getByText(/Last synced through/)).toBeOnTheScreen();
  expect(query.mock.lastCall?.[0].to_ms).toBe(end);
});

test("network identifies both series before scrubbing and history mounts only visible event rows", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const events = Array.from({ length: 60 }, (_, index) => ({
    ...record,
    ts_ms: record.ts_ms + index * 1000,
    processes: [`process-${index}`],
  }));
  jest
    .spyOn(transport, "queryEvents")
    .mockResolvedValue({ status: "ok", data: events });
  await renderWithProviders(openModule(MOCK_HOST_ID, "network"), { transport });
  expect(
    await screen.findByText("Fans ramped up · process-59")
  ).toBeOnTheScreen();
  expect(
    screen.queryByText("Fans ramped up · process-0")
  ).not.toBeOnTheScreen();
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
  const history = jest.spyOn(transport, "queryHistory");
  const events = jest.spyOn(transport, "queryEvents");
  await renderWithProviders(openModule(remote.config.id), { transport });
  await waitFor(() => expect(history).toHaveBeenCalled());
  expect(history).toHaveBeenCalledTimes(1);
  const request = history.mock.lastCall?.[0];
  if (!request) throw new Error("History request did not run");
  expect(request.to_ms - now).toBeGreaterThanOrEqual(
    remote.status.clock_offset_ms ?? 0
  );
  expect(request.to_ms - now).toBeLessThan(
    (remote.status.clock_offset_ms ?? 0) + 1000
  );
  expect(events.mock.calls).toEqual([
    [remote.config.id, request.from_ms, request.to_ms],
  ]);
});

test("reports a locked history store and an unreachable events source", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  jest.spyOn(transport, "queryHistory").mockResolvedValue({
    status: "error",
    error: { kind: "history_unavailable", reason: { kind: "locked" } },
  });
  jest.spyOn(transport, "queryEvents").mockResolvedValue({
    status: "error",
    error: { kind: "remote_unreachable", message: "Host offline" },
  });
  await renderWithProviders(openModule(), { transport });
  expect(
    await screen.findByText(
      /another copy of StatGlass has the history file open/,
      {},
      { timeout: 2000 }
    )
  ).toBeOnTheScreen();
  expect(screen.getByRole("alert", { name: /events/i })).toBeOnTheScreen();
  expect(screen.queryByText("No events in this range")).not.toBeOnTheScreen();
});

test("an unsupported module link gives an unavailable state without reading history", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const read = jest.spyOn(transport, "queryHistory");
  await renderWithProviders(openModule(MOCK_HOST_ID, "disk"), { transport });
  expect(screen.getByText("This module isn’t available.")).toBeOnTheScreen();
  expect(read).not.toHaveBeenCalled();
});
