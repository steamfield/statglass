import "react-native-gesture-handler/jestSetup";

import type { Event, LiveMsg } from "@core/generated/types";
import { PAUSE_EXPLANATION } from "@core/history-state";
import { PROCESSES } from "@core/mock/fixtures";
import { createMockTransport } from "@core/mock-transport";
import { MINUTE_MS } from "@core/time-grid";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import {
  layoutChart,
  openModule,
  setModuleClock,
  waitForLiveSubscriber,
} from "@test/helpers/module-screen";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import * as Localization from "expo-localization";

beforeEach(setModuleClock);

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

async function openBattery(transport: ReturnType<typeof createMockTransport>) {
  await openModule(transport, "battery");
  await waitForLiveSubscriber(transport);
  await act(() => transport.tick());
}

async function layoutCharge() {
  await layoutChart("battery-charge-layout", 310);
  await layoutChart("history-chart-plot", 260);
}

test("shows battery charge, capacity, signed power and energy-ranked processes", async () => {
  const [locale] = Localization.getLocales();
  jest
    .spyOn(Localization, "getLocales")
    .mockReturnValue([{ ...locale, temperatureUnit: "fahrenheit" }]);
  const transport = createMockTransport({ autoTick: false, historyRows: 3 });
  const original = transport.hostHistory.bind(transport);
  const read = jest
    .spyOn(transport, "hostHistory")
    .mockImplementation(async (request) => {
      const result = await original(request);
      if (request.events_for !== "battery" || result.status !== "ok")
        return result;
      const early: Event = {
        ts_ms: request.from_ms - 1,
        start_ms: request.from_ms - 1,
        detail: {
          kind: "alert",
          rule_id: "charge",
          rule_name: "Charge low",
          cause: {
            type: "threshold",
            metric: "battery.charge",
            labels: [],
            value: 12,
            op: "lt",
            threshold: 15,
            for_secs: 1,
          },
        },
        processes: [],
      };
      return {
        ...result,
        data: {
          ...result.data,
          events: [early],
          series: [
            {
              key: { metric: "battery.charge", labels: [] },
              hold_ms: 0,
              points: [{ t: request.from_ms, avg: 81, min: 80, max: 82 }],
            },
          ],
        },
      };
    });
  await openBattery(transport);
  await layoutCharge();

  expect(screen.getByRole("header", { name: "Battery" })).toBeOnTheScreen();
  expect(screen.getByText("On battery · 6:12 remaining")).toBeOnTheScreen();
  expect(
    screen.getByRole("image", { name: "Battery charge" })
  ).toHaveAccessibilityValue({ text: "87%" });
  expect(
    screen.getByRole("image", { name: "Battery health" })
  ).toHaveAccessibilityValue({ text: "94%" });
  expect(
    screen.getByRole("image", { name: "Battery power (W)" })
  ).toHaveAccessibilityValue({ text: "14.8" });
  expect(
    screen.getByText(/Drawn from the battery · System .* W/)
  ).toBeOnTheScreen();
  expect(screen.getByText("Cycles · 212")).toBeOnTheScreen();
  for (const label of [
    "Full charge",
    "Charge",
    "Health",
    "Cycles",
    "Remaining",
    "Temperature",
  ]) {
    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  }
  expect(screen.getByText("68.2 of 72.6 Wh")).toBeOnTheScreen();
  expect(screen.getByText("88 °F")).toBeOnTheScreen();
  expect(
    screen.getByRole("adjustable", { name: "Battery charge history" })
  ).toBeOnTheScreen();
  expect(await screen.findByText("now")).toBeOnTheScreen();
  expect(screen.getByText("100%")).toBeOnTheScreen();
  await waitFor(() =>
    expect(
      screen.getByRole("adjustable", { name: "Battery charge history" })
    ).not.toBeBusy()
  );
  await fireEvent(
    screen.getByRole("adjustable", { name: "Battery charge history" }),
    "accessibilityAction",
    {
      nativeEvent: { actionName: "increment" },
    }
  );
  expect(screen.getByText("Charge · 81%")).toBeOnTheScreen();
  expect(screen.queryByText(/Alert.*12%/)).not.toBeOnTheScreen();
  await fireEvent.press(screen.getByRole("tab", { name: "5m, History range" }));
  await waitFor(() =>
    expect(
      read.mock.calls.some(
        ([request]) =>
          request.events_for === "battery" &&
          request.series[0]?.metric === "battery.charge" &&
          request.to_ms === request.from_ms + 5 * MINUTE_MS
      )
    ).toBe(true)
  );

  const [xcode, , , safari] = PROCESSES;
  if (!xcode || !safari) throw new Error("Missing process fixtures");
  await act(() =>
    transport.push({
      kind: "processes",
      ts_ms: Date.now(),
      rows: [
        { ...xcode, energy: 1 },
        { ...safari, energy: 99 },
      ],
    })
  );
  const [first, second] = screen.getAllByLabelText(/^(Safari|Xcode)$/);
  expect(first === screen.getByLabelText("Safari")).toBe(true);
  expect(second === screen.getByLabelText("Xcode")).toBe(true);
});

test("shows the unavailable state on a host without a battery", async () => {
  const transport = createMockTransport({
    autoTick: false,
    historyRows: 2,
    scenarios: ["no-battery"],
  });
  const read = jest.spyOn(transport, "hostHistory");
  await openBattery(transport);
  expect(screen.getByText("Not present on this host")).toBeOnTheScreen();
  expect(
    screen.queryByRole("adjustable", { name: "Battery charge history" })
  ).not.toBeOnTheScreen();
  expect(read).not.toHaveBeenCalled();
});

test("retries a busy host, then distinguishes an empty history and its gap from current charge", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const read = jest.spyOn(transport, "hostHistory");
  for (let attempt = 0; attempt < 3; attempt++)
    transport.failNext("hostHistory", {
      kind: "remote_busy",
      message: "Try again",
    });
  await openBattery(transport);
  await layoutCharge();
  expect(screen.getByText("Loading history…")).toBeOnTheScreen();
  await act(() => jest.advanceTimersByTimeAsync(3000));
  expect(await screen.findByText(/StatGlass on .* is busy/)).toBeOnTheScreen();
  expect(read).toHaveBeenCalledTimes(3);
  await act(() => transport.tick());
  read.mockImplementation(async (request) => ({
    status: "ok",
    data: {
      tier: "m1",
      bucket_ms: MINUTE_MS,
      complete_to_ms: request.to_ms ?? request.from_ms,
      gaps: [
        {
          start_ms: request.from_ms + 5 * MINUTE_MS,
          end_ms: request.from_ms + 20 * MINUTE_MS,
          module: "battery",
          reason: "paused",
        },
      ],
      series: [],
      stats: [],
      events: [],
      clamped: [],
    },
  }));
  await fireEvent.press(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("No samples in this range")).toBeOnTheScreen();
  expect(
    screen.getByRole("note", { name: PAUSE_EXPLANATION })
  ).toBeOnTheScreen();
  expect(
    screen.getByRole("image", { name: "Battery charge" })
  ).toHaveAccessibilityValue({ text: "87%" });
});

test.each([
  {
    source: "charging",
    power: 6,
    minutes: 45,
    subtitle: "Charging · 0:45 to full",
    detail: "Charging the battery",
    figure: "6.0",
  },
  {
    source: "adapter",
    power: 0,
    minutes: null,
    subtitle: "On power adapter, not charging",
    detail: "No current into or out of the battery",
    figure: "0.0",
  },
  {
    source: "battery",
    power: null,
    minutes: null,
    subtitle: "On battery",
    detail: "No reading",
    figure: "—",
  },
] as const)(
  "shows $source status and distinguishes $power W from a gap",
  async ({ source, power, minutes, subtitle, detail, figure }) => {
    const transport = createMockTransport({ autoTick: false, historyRows: 2 });
    const subscribe = transport.subscribeLive.bind(transport);
    const messages: LiveMsg[] = [];
    jest
      .spyOn(transport, "subscribeLive")
      .mockImplementation((host, receive, options) =>
        subscribe(
          host,
          (message) => {
            messages.push(message);
            receive(message);
          },
          options
        )
      );
    await openBattery(transport);
    const frame = messages.findLast((message) => message.kind === "frame");
    const layout = messages.findLast(
      (message) =>
        message.kind === "layout" && message.layout_no === frame?.layout_no
    );
    if (!frame || layout?.kind !== "layout")
      throw new Error("Missing live fixture frame");
    const readings = layout.series.map(({ metric }, index) => {
      if (metric === "battery.power") return power;
      if (metric === "battery.time_remaining") return minutes;
      return frame.held[index] ?? null;
    });
    await act(() => {
      transport.push({
        kind: "status",
        interval_ms: 1000,
        frame_period_ms: 1000,
        paused: false,
        display_idle: false,
        on_battery: source === "battery",
        performance: "off",
        power_source: source,
        primary_iface: "en0",
      });
      transport.push({
        ...frame,
        ts_ms: frame.ts_ms + 1000,
        values: readings,
        held: readings,
      });
    });
    expect(screen.getByText(subtitle)).toBeOnTheScreen();
    expect(
      screen.getByText(new RegExp(`^${detail} · System`))
    ).toBeOnTheScreen();
    expect(
      screen.getByRole("image", { name: "Battery power (W)" })
    ).toHaveAccessibilityValue({ text: figure });
  }
);
