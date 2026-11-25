import "react-native-gesture-handler/jestSetup";

import { commandError } from "@core/command-error";
import { eventLabel } from "@core/events";
import {
  formatClockSeconds,
  formatHistoryTime,
  formatPercent,
} from "@core/format";
import type {
  Event,
  HostHistoryPage,
  HostHistoryRequest,
} from "@core/generated/types";
import { PAUSE_EXPLANATION } from "@core/history-state";
import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { phoneCommandFailures } from "@core/mock/phone-errors";
import { createMockTransport, type MockTransport } from "@core/mock-transport";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "@core/time-grid";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { mockAppState } from "@test/helpers/mock-app-state";
import { renderWithProviders } from "@test/render";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import { ExpoRoot, Link, router, Stack } from "expo-router";
import { getMockContext } from "expo-router/build/testing-library/mock-config";
import { AppState } from "react-native";
import { createGestureController } from "react-native-gesture-handler/jest-utils";
import { ModuleScreen } from "@/module";
import { ModuleChart } from "@/module/module-chart";

jest.mock("react-native-worklets", () =>
  jest.requireActual("react-native-worklets/src/mock")
);

const context = getMockContext({
  _layout: () => <Stack screenOptions={{ headerShown: false }} />,
  "[host]/[module]": ModuleScreen,
  settings: () => <Link href="/">Elsewhere</Link>,
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
  mockAppState();
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

async function layoutAxis() {
  await fireEvent(screen.getByTestId("history-chart-plot"), "layout", {
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

test("quick ranges and More each ask once, and More stops at seven days", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const early = {
    ...record,
    ts_ms: now - HOUR_MS - 1000,
    detail: {
      ...record.detail,
      kind: "sustained_process" as const,
      process: "Early worker",
      cpu_pct: 80,
      secs: 30,
    },
  };
  const history = observeHistory(transport, eventsReply([early, record]));
  await renderWithProviders(openModule(), { transport });
  await layoutPlot();

  expect(await screen.findAllByRole("tab")).toHaveLength(3);
  expect(screen.getByRole("tab", { name: "1h, History range" })).toBeSelected();
  expect(
    await screen.findByText(formatClockSeconds(record.ts_ms))
  ).toBeOnTheScreen();

  expect(screen.queryByText(eventLabel(early))).not.toBeOnTheScreen();
  await fireEvent.press(screen.getByRole("tab", { name: "5m, History range" }));
  expect(history.charts()).toHaveLength(2);
  const fiveMinutes = history.charts().at(-1);
  expect((fiveMinutes?.to_ms ?? 0) - (fiveMinutes?.from_ms ?? 0)).toBe(
    5 * MINUTE_MS
  );
  await fireEvent.press(screen.getByRole("tab", { name: "1h, History range" }));
  expect(history.charts()).toHaveLength(3);
  await fireEvent.press(
    screen.getByRole("tab", { name: "More, History range" })
  );
  expect(
    screen.queryByRole("button", { name: "Last 30 days" })
  ).not.toBeOnTheScreen();
  expect(screen.getByRole("button", { name: "Last 1 day" })).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole("button", { name: "Last 7 days" }));
  expect(screen.queryByRole("button", { name: "Done" })).not.toBeOnTheScreen();
  expect(screen.getByRole("tab", { name: "7d, History range" })).toBeSelected();
  expect(history.charts()).toHaveLength(4);
  const week = history.charts().at(-1);
  expect((week?.to_ms ?? 0) - (week?.from_ms ?? 0)).toBe(7 * DAY_MS);
  expect(week).toMatchObject({
    host: MOCK_HOST_ID,
    series: [
      { metric: "cpu.total", labels: [] },
      { metric: "cpu.system", labels: [] },
    ],
    events_for: "cpu",
  });
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
    .spyOn(Haptics, "impactAsync")
    .mockResolvedValue(undefined);
  await renderWithProviders(openModule(), { transport });
  await layoutPlot();
  await waitFor(() =>
    expect(screen.queryByText("Loading history…")).not.toBeOnTheScreen()
  );
  const chart = screen.getByRole("adjustable", { name: "CPU history" });
  const from = history.charts().at(-1)?.from_ms ?? now - HOUR_MS;
  await layoutAxis();
  expect(
    screen.getByRole("note", { name: PAUSE_EXPLANATION })
  ).toBeOnTheScreen();
  const pan = createGestureController("history-pan");
  await act(() => {
    pan.begin({ x: 0 });
    pan.activate({ x: 0 });
  });
  expect(screen.getByText("Total · 30%")).toBeOnTheScreen();
  expect(screen.getByText(formatClockSeconds(from))).toBeOnTheScreen();
  await act(() => pan.end());
  expect(screen.queryByText("Total · 30%")).not.toBeOnTheScreen();

  const longPress = createGestureController("history-pin");
  await act(() => {
    longPress.begin({ x: 5 });
    longPress.activate({ x: 5 });
    longPress.end();
  });
  expect(selection).toHaveBeenCalledTimes(1);
  expect(selection).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Medium);
  expect(screen.getByText("Total · —")).toBeOnTheScreen();
  expect(
    screen.getByText(formatClockSeconds(from + MINUTE_MS))
  ).toBeOnTheScreen();
  expect(chart).toHaveAccessibilityValue({
    text: `${formatClockSeconds(from + MINUTE_MS)}, Total: No samples, System: No samples`,
  });
  await fireEvent.press(screen.getByRole("button", { name: "Clear pin" }));
  expect(screen.queryByText("Total · —")).not.toBeOnTheScreen();
});

test("loading resolves to explicit empty history and events", async () => {
  const transport = createMockTransport({
    autoTick: false,
    historyRows: 0,
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
    .spyOn(Haptics, "impactAsync")
    .mockResolvedValue(undefined);
  await renderWithProviders(openModule(), { transport });
  await layoutPlot();
  const plot = await screen.findByRole("adjustable", { name: "CPU history" });
  await layoutAxis();
  for (const tick of ["100%", "50%", "0%", "now"])
    expect(screen.getByText(tick)).toBeOnTheScreen();
  await waitFor(() =>
    expect(screen.queryByText("Loading history…")).not.toBeOnTheScreen()
  );
  await fireEvent(plot, "accessibilityAction", {
    nativeEvent: { actionName: "increment" },
  });
  expect(plot).toHaveAccessibilityValue({
    text: /Total: 30%, System: No samples/,
  });
  await fireEvent(plot, "accessibilityAction", {
    nativeEvent: { actionName: "increment" },
  });
  expect(plot).toHaveAccessibilityValue({
    text: /Total: No samples, System: No samples/,
  });
  await fireEvent(plot, "accessibilityTap");
  expect(screen.getByRole("button", { name: "Clear pin" })).toBeOnTheScreen();
  expect(selection).toHaveBeenCalledTimes(1);
  expect(selection).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Medium);
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
  jest.spyOn(Haptics, "impactAsync").mockResolvedValue(undefined);
  await renderWithProviders(openModule(), { transport });
  await layoutPlot();
  const plot = await screen.findByRole("adjustable", { name: "CPU history" });
  await waitFor(() =>
    expect(screen.queryByText("Loading history…")).not.toBeOnTheScreen()
  );
  const request = history.charts().at(-1);
  if (!request || request.to_ms === null)
    throw new Error("History request did not include an end");
  await layoutAxis();
  const pin = createGestureController("history-pin");
  await act(() => {
    pin.begin({ x: 300 });
    pin.activate({ x: 300 });
    pin.end();
  });
  expect(plot).toHaveAccessibilityValue({
    text: `${formatClockSeconds(request.to_ms - MINUTE_MS)}, Total: No samples, System: No samples`,
  });
});

test("a foreground module refreshes both history and events as time advances", async () => {
  const changeAppState = mockAppState();
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const history = observeHistory(transport);
  const view = await renderWithProviders(openModule(), { transport });
  await layoutPlot();
  await waitFor(() => expect(history.charts()).toHaveLength(1));
  const end = history.charts().at(-1)?.to_ms ?? 0;
  await changeAppState("background");
  await act(() => jest.advanceTimersByTimeAsync(2 * MINUTE_MS));
  expect(history.charts()).toHaveLength(1);
  await changeAppState("active");
  await waitFor(() => expect(history.charts()).toHaveLength(2));
  expect(history.charts().at(-1)?.to_ms).toBeGreaterThanOrEqual(
    end + 2 * MINUTE_MS
  );
  expect(history.charts().at(-1)?.events_for).toBe("cpu");
  await act(() => jest.advanceTimersByTimeAsync(MINUTE_MS));
  expect(history.charts()).toHaveLength(3);
  await view.unmount();
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
    jest.spyOn(Haptics, "impactAsync").mockResolvedValue(undefined);
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
      const value = {
        text: `${formatClockSeconds(request.from_ms)}, Total: 30%, System: No samples`,
      };
      await layoutAxis();
      expect(screen.getByText("now")).toBeOnTheScreen();
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
      expect(screen.queryByText("now")).not.toBeOnTheScreen();
      expect(screen.queryByText("Loading history…")).not.toBeOnTheScreen();
      expect(screen.getAllByText(eventLabel(record))).toHaveLength(2);
      expect(
        screen.getByRole("button", { name: "Clear pin" })
      ).toBeOnTheScreen();
      expect(plot()).toHaveAccessibilityValue(value);

      await fireEvent.press(
        screen.getByRole("tab", { name: "More, History range" })
      );
      await fireEvent.press(
        screen.getByRole("button", { name: "Last 7 days" })
      );
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
  transport.failNext("listRemoteHosts", phoneCommandFailures.statusEndpoint);
  transport.failNext("listRemoteHosts", phoneCommandFailures.statusEndpoint);
  const history = jest.spyOn(transport, "hostHistory");
  await renderWithProviders(openModule(remote.config.id), { transport });
  expect(
    await screen.findByRole(
      "alert",
      {
        name: "Couldn’t read connection status. Status endpoint unavailable.",
      },
      { timeout: 2000 }
    )
  ).toBeOnTheScreen();
  expect(history).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("tab", { name: "1h, History range" })
  ).toBeOnTheScreen();
  expect(screen.queryByRole("alert")).not.toBeOnTheScreen();
});

test("an offline host uses its last-seen host time on the module page", async () => {
  const transport = createMockTransport({
    scenarios: ["phone-errors"],
    autoTick: false,
    historyRows: 2,
  });
  await renderWithProviders(openModule("phone-offline"), { transport });
  expect(await screen.findByText("Offline since 14:02")).toBeOnTheScreen();
  expect(screen.queryByText(/Last synced through/)).toBeNull();
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
  expect(screen.getByText(/^↓ Download · /)).toBeOnTheScreen();
  expect(screen.getByText(/^↑ Upload · /)).toBeOnTheScreen();
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

// A host that predates range totals sends none.
const NO_TOTALS = { measured_ms: null, integral: null };

test("the stat strip keys Avg and Peak to the unlabelled lead series in the host reply", async () => {
  const transport = createMockTransport({ autoTick: false });
  observeHistory(transport, async (request) => ({
    status: "ok",
    data: {
      ...cpuPage(request),
      stats: [
        {
          key: { metric: "cpu.total", labels: [["scope", "other"]] },
          avg: 88,
          peak: 99,
          ...NO_TOTALS,
        },
        {
          key: { metric: "cpu.system", labels: [] },
          avg: 77,
          peak: 98,
          ...NO_TOTALS,
        },
        {
          key: { metric: "cpu.total", labels: [] },
          avg: (request.to_ms ?? 0) - request.from_ms === HOUR_MS ? 12.5 : null,
          peak: (request.to_ms ?? 0) - request.from_ms === HOUR_MS ? 91 : null,
          ...NO_TOTALS,
        },
      ],
    },
  }));
  await renderWithProviders(openModule(), { transport });
  await layoutPlot();
  await waitFor(() =>
    expect(screen.getByLabelText("Avg")).toHaveAccessibilityValue({
      text: "12.5%",
    })
  );
  expect(screen.getByLabelText("Peak")).toHaveAccessibilityValue({
    text: "91%",
  });
  expect(screen.getByLabelText("Total")).toHaveAccessibilityValue({
    text: "18%",
  });
  await fireEvent.press(screen.getByRole("tab", { name: "5m, History range" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Peak")).toHaveAccessibilityValue({
      text: "—",
    })
  );
  expect(screen.getByLabelText("Avg")).toHaveAccessibilityValue({ text: "—" });
});

test("colliding events appear in pill rows or a merged pill as well as in the event list", async () => {
  const transport = createMockTransport({ autoTick: false });
  const clustered = Array.from(
    { length: 5 },
    (_, i): Event => ({
      ...record,
      ts_ms: now - 10 * MINUTE_MS + 1000 * i,
      detail: {
        kind: "sustained_process",
        process: `Build worker ${i}`,
        cpu_pct: 90,
        secs: 30,
      },
    })
  );
  observeHistory(transport, eventsReply(clustered));
  await renderWithProviders(openModule(), { transport });
  await layoutPlot();
  await layoutAxis();
  const pills = await screen.findAllByLabelText(/^Build worker /);
  if (pills.length < clustered.length) {
    expect(screen.getByLabelText(/Build worker .*\+\d/)).toBeOnTheScreen();
  }
  expect(
    screen.getByText(formatClockSeconds(now - 10 * MINUTE_MS))
  ).toBeOnTheScreen();
});

test("the mock host filters a power spike out of Network history and events", async () => {
  const transport = createMockTransport({ autoTick: false });
  const read = jest.spyOn(transport, "hostHistory");
  await renderWithProviders(openModule(MOCK_HOST_ID, "network"), { transport });
  await layoutPlot();
  await layoutAxis();
  expect(await screen.findByText("No events in this range")).toBeOnTheScreen();
  expect(screen.queryByText(/ANE.*Photos/)).not.toBeOnTheScreen();
  expect(read).toHaveBeenCalledWith(
    expect.objectContaining({ events_for: "network" })
  );
});

test("full process interest ranks grouped apps, shows the top ten, and stops on blur", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const interest = jest.spyOn(transport, "setProcessInterest");
  await renderWithProviders(openModule(MOCK_HOST_ID, "memory"), { transport });
  await waitFor(() =>
    expect(interest).toHaveBeenCalledWith(
      MOCK_HOST_ID,
      true,
      { sort: [], limit: null, period_ms: null },
      expect.any(Number)
    )
  );
  expect(screen.getByText("Waiting for live processes…")).toBeOnTheScreen();
  await act(() => jest.advanceTimersByTimeAsync(1000));
  await act(() => transport.tick());
  const expected = [
    "Xcode",
    "com.docker.backend",
    "Safari",
    "Figma",
    "kernel_task",
    "node",
    "WindowServer",
    "Google Chrome",
    "Code",
    "mdworker_shared",
  ];
  await waitFor(() =>
    expect(
      screen.getAllByLabelText(new RegExp(`^(${expected.join("|")})$`))
    ).toHaveLength(10)
  );
  const rows = screen.getAllByLabelText(
    new RegExp(`^(${expected.join("|")})$`)
  );
  expect(rows).toEqual(expected.map((app) => screen.getByLabelText(app)));
  expect(screen.queryByLabelText("zsh")).not.toBeOnTheScreen();
  await act(() => router.push("/settings"));
  expect(await screen.findByText("Elsewhere")).toBeOnTheScreen();
  await waitFor(() =>
    expect(interest).toHaveBeenLastCalledWith(
      MOCK_HOST_ID,
      false,
      null,
      expect.any(Number)
    )
  );
});

test("VoiceOver steps past a leading partial bucket and reads a right-aligned shorter series", async () => {
  await renderWithProviders(
    <ModuleChart
      series={[
        { key: "total", label: "Total", values: [30, 40], step: 1 },
        { key: "system", label: "System", values: [7], step: 2 },
      ]}
      gaps={[]}
      ceiling={100}
      format={formatPercent}
      range={{ fromMs: now - MINUTE_MS, toMs: now, rolling: false }}
      events={[]}
      clockOffsetMs={0}
      height={160}
      grid={{ endMs: now - MINUTE_MS / 2, bucketMs: MINUTE_MS }}
      label="CPU history"
    />
  );
  const plot = screen.getByRole("adjustable", { name: "CPU history" });
  await fireEvent(plot, "accessibilityAction", {
    nativeEvent: { actionName: "increment" },
  });
  expect(plot).toHaveAccessibilityValue({
    text: `${formatClockSeconds(now - 1.5 * MINUTE_MS)}, Total: 30%, System: No samples`,
  });
  await fireEvent(plot, "accessibilityAction", {
    nativeEvent: { actionName: "increment" },
  });
  expect(plot).toHaveAccessibilityValue({
    text: `${formatClockSeconds(now - 0.5 * MINUTE_MS)}, Total: 40%, System: 7%`,
  });
});

test("Linux power reports that its host does not measure process energy", async () => {
  const transport = createMockTransport({
    scenarios: ["linux"],
    autoTick: false,
    historyRows: 2,
  });
  await renderWithProviders(openModule(MOCK_HOST_ID, "power"), { transport });
  await waitFor(() => expect(transport.subscriberCount()).toBe(1));
  await act(() => jest.advanceTimersByTimeAsync(1000));
  await act(() => transport.tick());
  expect(
    await screen.findByText(
      "Energy measurements are not available from this host."
    )
  ).toBeOnTheScreen();
  expect(screen.queryByText("0.0")).not.toBeOnTheScreen();
});

test("a failed process interest request reports the transport failure", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const error = {
    kind: "internal",
    message: "Process stream unavailable.",
  } as const;
  jest
    .spyOn(transport, "setProcessInterest")
    .mockResolvedValueOnce({ status: "error", error });
  await renderWithProviders(openModule(), { transport });
  expect(
    await screen.findByRole("alert", {
      name: "Couldn’t load live processes. Process stream unavailable.",
    })
  ).toBeOnTheScreen();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(commandError(warn.mock.calls[0]?.[2])).toEqual(error);
});

test("a host that provides frames without processes shows their unavailable state", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const interest = jest
    .spyOn(transport, "setProcessInterest")
    .mockResolvedValue({ status: "ok", data: null });
  await renderWithProviders(openModule(), { transport });
  await waitFor(() => expect(interest).toHaveBeenCalled());
  expect(screen.getByText("Waiting for live processes…")).toBeOnTheScreen();
  await act(() => jest.advanceTimersByTimeAsync(1000));
  await act(() => transport.tick());
  expect(
    await screen.findByText("Processes are not available from this host")
  ).toBeOnTheScreen();
});
