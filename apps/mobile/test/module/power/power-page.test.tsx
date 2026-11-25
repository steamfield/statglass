import "react-native-gesture-handler/jestSetup";

import { formatTemperature, formatWatts, temperatureParts } from "@core/format";
import type { Event } from "@core/generated/types";
import { capabilities, MOCK_HOST_ID, PROCESSES } from "@core/mock/fixtures";
import { createMockTransport } from "@core/mock-transport";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "@core/time-grid";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { mockAppState } from "@test/helpers/mock-app-state";
import { renderWithProviders } from "@test/render";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react-native";
import * as Localization from "expo-localization";
import { ExpoRoot, Stack } from "expo-router";
import { getMockContext } from "expo-router/testing-library";
import { ModuleScreen } from "@/module";

jest.mock("react-native-worklets", () =>
  jest.requireActual("react-native-worklets/src/mock")
);

const context = getMockContext({
  _layout: () => <Stack />,
  "(hosts)/[host]/[module]": ModuleScreen,
});
const now = Date.UTC(2026, 10, 24, 15, 2);

beforeEach(() => {
  jest.useFakeTimers({ now });
  mockAppState();
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

function openPower(host = MOCK_HOST_ID) {
  return (
    <ExpoRoot
      context={context}
      location={new URL(`statglass:///${host}/power`)}
    />
  );
}

async function tick(transport: ReturnType<typeof createMockTransport>) {
  await waitFor(() => expect(transport.subscriberCount()).toBe(1));
  await act(() => transport.tick());
}

async function layout(testID: string, width = 310) {
  await fireEvent(await screen.findByTestId(testID), "layout", {
    nativeEvent: { layout: { width } },
  });
}

test.each([
  ["fahrenheit", "F"],
  ["celsius", "C"],
] as const)(
  "uses %s for rings, thermal rows, battery temperature, and thermal alerts",
  async (temperatureUnit, units) => {
    const [locale] = Localization.getLocales();
    jest
      .spyOn(Localization, "getLocales")
      .mockReturnValue([{ ...locale, temperatureUnit }]);
    const transport = createMockTransport({ autoTick: false, historyRows: 2 });
    const read = transport.hostHistory.bind(transport);
    jest.spyOn(transport, "hostHistory").mockImplementation(async (request) => {
      const reply = await read(request);
      if (request.events_for !== "power" || reply.status !== "ok") return reply;
      const alert: Event = {
        ts_ms: now - 25 * MINUTE_MS,
        start_ms: now - 25 * MINUTE_MS,
        detail: {
          kind: "alert",
          rule_id: "thermal",
          rule_name: "Thermal limit",
          cause: {
            type: "threshold",
            metric: "thermal.hottest",
            labels: [],
            value: 96,
            op: "gt",
            threshold: 90,
            for_secs: 1,
          },
        },
        processes: [],
      };
      return { ...reply, data: { ...reply.data, events: [alert] } };
    });
    await renderWithProviders(openPower(), { transport });
    await tick(transport);

    for (const [name, celsius] of [
      ["CPU", 61],
      ["GPU", 54],
    ] as const) {
      expect(
        screen.getByRole("image", { name: `${name} temperature (°${units})` })
      ).toHaveAccessibilityValue({
        text: temperatureParts(celsius, { units }).value,
      });
    }
    expect(screen.getAllByText(`°${units}`)).toHaveLength(2);
    const matrix = screen.getByRole("image", { name: "SoC thermal zones" });
    expect(matrix).toHaveAccessibilityValue({
      text: new RegExp(
        `^${Array.from({ length: 10 }, (_, i) => `Zone ${String(i + 1).padStart(2, "0")} \\([^)]+\\) \\d+ °${units}`).join(", ")}$`
      ),
    });
    expect(
      screen.getByText(formatTemperature(20, { units }))
    ).toBeOnTheScreen();
    expect(
      screen.getByText(formatTemperature(110, { units }))
    ).toBeOnTheScreen();
    expect(
      screen.getAllByText(formatTemperature(31, { units })).length
    ).toBeGreaterThan(0);
    expect(
      screen.queryAllByText(new RegExp(`°${units === "F" ? "C" : "F"}`))
    ).toHaveLength(0);
    await layout("history-plot-layout");
    const chart = within(screen.getByTestId("history-plot-layout"));
    await fireEvent(chart.getByTestId("history-chart-plot"), "layout", {
      nativeEvent: { layout: { width: 310 } },
    });
    const label = `Alert · Hottest sensor ${formatTemperature(96, { units })}`;
    await waitFor(() => expect(screen.queryAllByText(label)).toHaveLength(2));
    expect(screen.getByLabelText(label)).toBeOnTheScreen();
  }
);

test("shows Mac power figures, isolated chart history and energy-ranked live processes", async () => {
  const transport = createMockTransport({
    autoTick: false,
    historyRows: 3,
    scenarios: ["cpu-power-calibrated"],
  });
  const read = transport.hostHistory.bind(transport);
  const history = jest
    .spyOn(transport, "hostHistory")
    .mockImplementation(async (request) => {
      const result = await read(request);
      if (request.events_for !== "power" || result.status === "error")
        return result;
      return {
        ...result,
        data: {
          ...result.data,
          stats: [
            {
              key: { metric: "power.system", labels: [] },
              avg: 12.3,
              peak: request.to_ms === request.from_ms + HOUR_MS ? 25.4 : 200,
              measured_ms: null,
              integral: null,
            },
          ],
          series: [
            {
              key: { metric: "power.system", labels: [] },
              hold_ms: 0,
              points: [{ t: request.from_ms, avg: 17.2, min: 16, max: 19 }],
            },
          ],
        },
      };
    });
  await renderWithProviders(openPower(), { transport });
  await tick(transport);
  await layout("history-plot-layout");
  await layout("battery-charge-layout");
  expect(await screen.findByText("CPU power: P cores")).toBeOnTheScreen();
  expect(
    screen.getByRole("header", { name: "Power & Sensors" })
  ).toBeOnTheScreen();
  expect(screen.getByText(/On battery · .* W system draw/)).toBeOnTheScreen();
  expect(screen.getByText(/P-cluster · .* GHz/)).toBeOnTheScreen();
  expect(screen.getByText(/Frequency · .* GHz/)).toBeOnTheScreen();
  expect(screen.getByText(/Left .* right .* · Automatic/)).toBeOnTheScreen();
  expect(
    screen.getByText(/Drawn from battery · Package .* W/)
  ).toBeOnTheScreen();
  expect(
    screen.getByRole("image", { name: "Fan speed (RPM)" })
  ).toBeOnTheScreen();
  expect(
    screen.getByRole("image", { name: "System draw (W)" })
  ).toBeOnTheScreen();
  for (const name of ["System", "CPU", "GPU", "ANE", "DRAM"]) {
    expect(
      screen.getByLabelText(name, { exact: true })
    ).toHaveAccessibilityValue({ text: /^[\d.]+ W$/ });
  }
  await waitFor(() =>
    expect(screen.getByLabelText("Avg")).toHaveAccessibilityValue({
      text: formatWatts(12.3),
    })
  );
  expect(screen.getByLabelText("Peak")).toHaveAccessibilityValue({
    text: formatWatts(25.4),
  });
  expect(
    screen.getByRole("adjustable", { name: "Power & Sensors history" })
  ).toBeOnTheScreen();
  const plot = within(screen.getByTestId("history-plot-layout"));
  await fireEvent(plot.getByTestId("history-chart-plot"), "layout", {
    nativeEvent: { layout: { width: 310 } },
  });
  expect(await plot.findByText("now")).toBeOnTheScreen();
  expect(plot.getByText(formatWatts(0))).toBeOnTheScreen();
  expect(plot.getByText("System")).toBeOnTheScreen();
  await fireEvent(
    screen.getByRole("adjustable", { name: "Power & Sensors history" }),
    "accessibilityAction",
    {
      nativeEvent: { actionName: "increment" },
    }
  );
  expect(plot.getByText("System · 17.2 W")).toBeOnTheScreen();
  expect(
    screen.getByRole("header", { name: "Battery charge, last 24 hours" })
  ).toBeOnTheScreen();
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
  const systemArc = () =>
    within(screen.getByRole("image", { name: "System draw (W)" })).getByTestId(
      "ring-arc"
    ).props.strokeDashoffset;
  const offset = systemArc();
  await fireEvent.press(screen.getByRole("tab", { name: "5m, History range" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Peak")).toHaveAccessibilityValue({
      text: formatWatts(200),
    })
  );
  expect(systemArc()).toBe(offset);
  expect(
    screen.queryByText(/Drag across the chart|app power|Energy by app/i)
  ).not.toBeOnTheScreen();
  expect(
    history.mock.calls.map(([request]) =>
      request.series.map(({ metric }) => metric)
    )
  ).toContainEqual(["power.system"]);
  expect(
    history.mock.calls.map(([request]) =>
      request.series.map(({ metric }) => metric)
    )
  ).toContainEqual(Array.from({ length: 10 }, () => "thermal.zone"));
  expect(
    history.mock.calls.some(
      ([request]) =>
        request.series[0]?.metric === "battery.charge" &&
        request.events_for === null &&
        request.to_ms === request.from_ms + DAY_MS
    )
  ).toBe(true);
});

test("draws named Linux sensors and rails with only the reported rings", async () => {
  const transport = createMockTransport({
    autoTick: false,
    historyRows: 2,
    scenarios: ["linux"],
  });
  await renderWithProviders(openPower(), { transport });
  await tick(transport);
  expect(
    screen.getByRole("image", { name: "Temperature sensors" })
  ).toBeOnTheScreen();
  expect(screen.getByText("NAND Flash Temperature")).toBeOnTheScreen();
  expect(
    screen.getByRole("image", { name: "System draw (W)" })
  ).toBeOnTheScreen();
  expect(
    screen.getByRole("image", { name: "Fan speed (RPM)" })
  ).toBeOnTheScreen();
  expect(screen.getByLabelText("3.8 V Rail Power")).toHaveAccessibilityValue({
    text: /^[\d.]+ W$/,
  });
  expect(
    screen.queryByRole("image", {
      name: /CPU temperature|GPU temperature|SoC thermal zones/,
    })
  ).not.toBeOnTheScreen();
  expect(
    screen.queryByText(/Battery charge|Automatic|Manual/)
  ).not.toBeOnTheScreen();
  expect(
    screen.getByText("Energy measurements are not available from this host.")
  ).toBeOnTheScreen();
});

const events: Event[] = [
  {
    detail: {
      kind: "power_spike",
      component: "ane",
      watts: 7.5,
      baseline_watts: 0,
    },
    ts_ms: now - 30 * MINUTE_MS,
    start_ms: now - 30 * MINUTE_MS,
    processes: [],
  },
  {
    detail: { kind: "fans_ramped", from_rpm: 1200, to_rpm: 2400 },
    ts_ms: now - 30 * MINUTE_MS,
    start_ms: now - 30 * MINUTE_MS,
    processes: [],
  },
  {
    detail: { kind: "thermal_state", from: "nominal", to: "serious" },
    ts_ms: now - 5 * MINUTE_MS,
    start_ms: now - 5 * MINUTE_MS,
    processes: [],
  },
];

test("keeps colliding events as pills and filters the rounded history boundary", async () => {
  const transport = createMockTransport({
    autoTick: false,
    historyRows: 2,
    scenarios: ["no-battery"],
  });
  const read = transport.hostHistory.bind(transport);
  jest.spyOn(transport, "hostHistory").mockImplementation(async (request) => {
    const reply = await read(request);
    if (reply.status !== "ok" || request.events_for !== "power") return reply;
    const early: Event = {
      ts_ms: request.from_ms - 1,
      start_ms: request.from_ms - 1,
      detail: {
        kind: "power_spike",
        component: "package",
        watts: 91,
        baseline_watts: 2,
      },
      processes: [],
    };
    return { ...reply, data: { ...reply.data, events: [early, ...events] } };
  });
  await renderWithProviders(openPower(), { transport });
  await tick(transport);
  await layout("history-plot-layout");
  await layout("history-chart-plot", 200);
  for (const label of [
    "ANE 7.5 W",
    "Fans ramped up",
    "Thermal state Serious",
  ]) {
    expect(await screen.findAllByText(label)).not.toHaveLength(0);
  }
  const pills = await screen.findAllByLabelText(
    /^(ANE 7\.5 W|Fans ramped up|Thermal state Serious)/
  );
  expect(pills.length).toBeLessThan(events.length);
  expect(screen.getByLabelText(/\+\d+$/)).toBeOnTheScreen();
  expect(screen.queryByText("Package 91.0 W")).not.toBeOnTheScreen();
});

test("explains an unsupported thermal query without hiding live figures or system history", async () => {
  const transport = createMockTransport({
    autoTick: false,
    historyRows: 2,
    scenarios: ["no-battery"],
  });
  const read = transport.hostHistory.bind(transport);
  jest.spyOn(transport, "hostHistory").mockImplementation(async (request) => {
    if (request.series[0]?.metric !== "thermal.zone") return read(request);
    return {
      status: "error",
      error: {
        kind: "remote_unsupported",
        message: "History requires a newer host",
      },
    };
  });
  await renderWithProviders(openPower(), { transport });
  await tick(transport);
  await layout("history-plot-layout");
  expect(
    await screen.findByText(/Update StatGlass on .* to see history/)
  ).toBeOnTheScreen();
  expect(
    screen.getByRole("image", { name: "System draw (W)" })
  ).toHaveAccessibilityValue({ text: /^\d/ });
  expect(screen.queryByRole("button", { name: "Retry" })).not.toBeOnTheScreen();
});

test("opens the Battery module from the embedded charge history", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  await renderWithProviders(openPower(), { transport });
  await tick(transport);
  await fireEvent.press(screen.getByRole("button", { name: "Open Battery" }));
  expect(
    await screen.findByRole("image", { name: "Battery health" })
  ).toBeOnTheScreen();
});

test("refreshes thermal buckets when returning to the hour and explains a server clamp", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 2 });
  const original = transport.hostHistory.bind(transport);
  const read = jest
    .spyOn(transport, "hostHistory")
    .mockImplementation(async (request) => {
      const result = await original(request);
      if (
        result.status !== "ok" ||
        request.series[0]?.metric !== "thermal.zone"
      )
        return result;
      return {
        ...result,
        data: { ...result.data, clamped: [{ kind: "series" }] },
      };
    });
  await renderWithProviders(openPower(), { transport });
  await tick(transport);
  const hourReads = () =>
    read.mock.calls.filter(
      ([request]) =>
        request.series[0]?.metric === "thermal.zone" &&
        request.to_ms === request.from_ms + HOUR_MS
    ).length;
  await waitFor(() => expect(hourReads()).toBe(1));
  await fireEvent.press(screen.getByRole("tab", { name: "5m, History range" }));
  await fireEvent.press(screen.getByRole("tab", { name: "1h, History range" }));
  await waitFor(() => expect(hourReads()).toBe(2));
  expect(
    await screen.findByText(
      "History is available for only some temperature sensors."
    )
  ).toBeOnTheScreen();
});

test.each([false, true])(
  "uses sensor capabilities when system power is unavailable (sensors: %s)",
  async (sensors) => {
    const transport = createMockTransport({
      autoTick: false,
      historyRows: 2,
      scenarios: ["linux"],
    });
    const actual = capabilities(transport.flags, {});
    const read = jest.spyOn(transport, "hostHistory");
    await renderWithProviders(openPower(), { transport });
    await tick(transport);
    await act(() =>
      transport.push({
        kind: "caps",
        capabilities: {
          ...actual,
          revision: actual.revision + 1,
          modules: {
            ...actual.modules,
            power: { unsupported: "no_hardware" },
            sensors: sensors ? { available: { series: 3 } } : "not_present",
          },
        },
      })
    );
    const notice = screen.queryByText("Not available on this host");
    const thermal = screen.queryByRole("image", {
      name: "Temperature sensors",
    });
    if (sensors) {
      expect(thermal).toBeOnTheScreen();
      expect(notice).not.toBeOnTheScreen();
    } else {
      expect(thermal).not.toBeOnTheScreen();
      expect(notice).toBeOnTheScreen();
    }
    expect(
      screen.queryByRole("adjustable", { name: "Power & Sensors history" })
    ).not.toBeOnTheScreen();
    expect(
      screen.queryByRole("image", { name: "System draw (W)" })
    ).not.toBeOnTheScreen();
    expect(
      read.mock.calls.some(([r]) => r.series[0]?.metric === "power.system")
    ).toBe(false);
  }
);

test("shows passive cooling on a fanless Mac", async () => {
  const transport = createMockTransport({
    autoTick: false,
    historyRows: 2,
    scenarios: ["no-fans"],
  });
  await renderWithProviders(openPower(), { transport });
  await tick(transport);
  expect(await screen.findByText("Passive cooling")).toBeOnTheScreen();
  expect(
    screen.queryByRole("image", { name: "Fan speed (RPM)" })
  ).not.toBeOnTheScreen();
});
