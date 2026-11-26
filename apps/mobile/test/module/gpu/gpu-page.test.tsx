import "react-native-gesture-handler/jestSetup";

import {
  fixed,
  formatGhz,
  formatPercent,
  formatWatts,
  MISSING,
} from "@core/format";
import { phoneCommandFailures } from "@core/mock/phone-errors";
import { createMockTransport } from "@core/mock-transport";
import { labelOf } from "@core/series-key";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import {
  expectStat,
  layoutChart,
  openModule,
  reading,
  setModuleClock,
  watchHeld,
  watchHistory,
} from "@test/module/cpu/fixtures";
import { act, fireEvent, screen } from "@testing-library/react-native";

beforeEach(setModuleClock);
afterEach(() => {
  jest.useRealTimers();
});

test("GPU shows host readings, range statistics, frequency residency, power and GPU-ranked processes", async () => {
  const transport = createMockTransport({ autoTick: false });
  const current = watchHeld(transport);
  const history = watchHistory(transport);
  const interest = jest.spyOn(transport, "setProcessInterest");
  await openModule(transport, "gpu");
  const held = await current();
  expect(await screen.findByText("Apple M4 Pro")).toBeOnTheScreen();
  const freq = reading(held, "gpu.freq");
  expectStat("Utilization", formatPercent(reading(held, "gpu.util")));
  expectStat("Renderer", formatPercent(reading(held, "gpu.render")));
  expectStat("Tiler", formatPercent(reading(held, "gpu.tiler")));
  expectStat("Frequency", formatGhz(freq, { decimals: 2 }));
  expectStat("Power", formatWatts(reading(held, "power.gpu")));

  await layoutChart();
  const residency = await screen.findByRole("image", {
    name: /residency:.* GHz.*idle/,
  });
  const stats = history.replies[0]?.stats ?? [];
  const states = ["1578", "1398", "1098", "720", "idle"].map((state) => {
    const result = stats.find(
      ({ key }) =>
        key.metric === "gpu.residency" && labelOf(key, "state") === state
    );
    if (result?.avg == null) throw new Error(`Missing residency for ${state}`);
    const label =
      state === "idle"
        ? state
        : formatGhz(Number(state) * 1e6, { decimals: 2 });
    return `${label} ${formatPercent(result.avg)}`;
  });
  expect(residency).toHaveAccessibleName(
    `last hour residency: ${states.join(", ")}`
  );
  expect(screen.getByRole("image", { name: "GHz" })).toHaveAccessibilityValue({
    text: `${fixed(freq / 1e9, 2)}, max 1.58`,
  });
  expect(history.read).toHaveBeenCalledTimes(1);
  expect(history.read).toHaveBeenCalledWith(
    expect.objectContaining({
      events_for: "gpu",
      series: ["gpu.util", "power.gpu", "gpu.residency"].map((metric) => ({
        metric,
        labels: [],
      })),
    })
  );
  const util = history.replies[0]?.stats.find(
    ({ key }) => key.metric === "gpu.util"
  );
  if (!util || util.avg === null || util.peak === null)
    throw new Error("Missing GPU range statistics");
  expectStat("Avg", formatPercent(util.avg, { decimals: 1 }));
  expectStat("Peak", formatPercent(util.peak));
  const power = screen.getByRole("adjustable", { name: "GPU power" });
  await fireEvent(power, "accessibilityAction", {
    nativeEvent: { actionName: "increment" },
  });
  expect(
    screen.getByRole("adjustable", { name: "GPU power" })
  ).toHaveAccessibilityValue({
    text: /Power: .*W/,
  });
  await fireEvent(
    screen.getByRole("adjustable", { name: "GPU history" }),
    "accessibilityAction",
    {
      nativeEvent: { actionName: "increment" },
    }
  );
  expect(
    screen.getByRole("adjustable", { name: "GPU history" })
  ).toHaveAccessibilityValue({
    text: /Utilization: \d+%/,
  });
  expect(interest).toHaveBeenCalledWith(
    expect.any(String),
    true,
    expect.objectContaining({ gpu: true }),
    expect.any(Number)
  );
  expect(
    screen.getAllByLabelText(/^(WindowServer|Figma|Safari|Xcode)$/)
  ).toEqual(
    ["WindowServer", "Figma", "Safari", "Xcode"].map((name) =>
      screen.getByLabelText(name)
    )
  );
  expect(
    screen.queryByText(/Every process|Avg GPU|System and other/)
  ).not.toBeOnTheScreen();
});

test("a host without GPU measurements shows the module’s unavailable state without a history request", async () => {
  const transport = createMockTransport({
    autoTick: false,
    scenarios: ["linux"],
  });
  const history = watchHistory(transport);
  await openModule(transport, "gpu");
  expect(
    await screen.findByText("Not available on this host")
  ).toBeOnTheScreen();
  expect(
    screen.queryByRole("adjustable", { name: "GPU history" })
  ).not.toBeOnTheScreen();
  expect(screen.queryByText("Live processes")).not.toBeOnTheScreen();
  expect(history.read).not.toHaveBeenCalled();
});

test("a successful empty GPU reply shows missing totals and no residency", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 0 });
  jest.spyOn(transport, "hostHistory").mockImplementation(async (request) => ({
    status: "ok",
    data: {
      tier: "m1",
      bucket_ms: 60_000,
      complete_to_ms: request.to_ms ?? request.from_ms,
      series: [],
      gaps: [],
      stats: [],
      events: [],
      clamped: [],
    },
  }));
  await openModule(transport, "gpu");
  await layoutChart();
  expect(await screen.findByText("No samples in this range")).toBeOnTheScreen();
  expect(screen.getByText(/^No frequency residency samples/)).toBeOnTheScreen();
  expectStat("Avg", MISSING);
  expectStat("Peak", MISSING);
  expect(
    screen.queryByRole("image", { name: /residency:/ })
  ).not.toBeOnTheScreen();
});

test("GPU history loads while the live subscription is retrying", async () => {
  const transport = createMockTransport({ autoTick: false });
  transport.failNext("subscribeLive", phoneCommandFailures.retryNetwork);
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    await openModule(transport, "gpu");
    expect(await screen.findByText("Reconnecting")).toBeOnTheScreen();
    await layoutChart();
    expect(
      await screen.findByRole("image", { name: /residency:.*idle/ })
    ).toBeOnTheScreen();
    expectStat("Utilization", MISSING);
  } finally {
    log.mockRestore();
  }
});

test("GPU shows when live readings go stale while its history remains visible", async () => {
  const transport = createMockTransport({ autoTick: false });
  const current = watchHeld(transport);
  await openModule(transport, "gpu");
  await current();
  await layoutChart();
  await act(() => jest.advanceTimersByTimeAsync(3500));
  expect(await screen.findByText("Reconnecting")).toBeOnTheScreen();
  expectStat("Utilization", MISSING);
  expect(
    screen.getByRole("adjustable", { name: "GPU history" })
  ).toBeOnTheScreen();
});

test("GPU explains missing power samples even when utilization history is present", async () => {
  const transport = createMockTransport({ autoTick: false });
  const original = transport.hostHistory.bind(transport);
  jest.spyOn(transport, "hostHistory").mockImplementation(async (request) => {
    const reply = await original(request);
    if (reply.status === "error") return reply;
    return {
      status: "ok",
      data: {
        ...reply.data,
        series: reply.data.series.filter(
          ({ key }) => key.metric !== "power.gpu"
        ),
      },
    };
  });
  await openModule(transport, "gpu");
  await layoutChart();
  expect(
    await screen.findByText("No power samples in this range")
  ).toBeOnTheScreen();
  expect(screen.queryByText("No samples in this range")).not.toBeOnTheScreen();
});
