import "react-native-gesture-handler/jestSetup";

import { fixed, formatHistoryTime, formatPercent } from "@core/format";
import type { HostHistoryPage } from "@core/generated/types";
import { PAUSE_EXPLANATION } from "@core/history-state";
import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { createMockTransport, type MockTransport } from "@core/mock-transport";
import { MINUTE_MS } from "@core/time-grid";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import {
  expectStat,
  layoutChart,
  openModule,
  reading,
  selectMoreRange,
  setModuleClock,
  watchHeld,
  watchHistory,
} from "@test/helpers/module-screen";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react-native";

beforeEach(setModuleClock);
afterEach(() => {
  jest.useRealTimers();
});

function uniformTopology(transport: MockTransport, cores: string[]) {
  const list = transport.listHosts.bind(transport);
  jest.spyOn(transport, "listHosts").mockImplementation(async () =>
    (await list()).map((host) => ({
      ...host,
      info: {
        ...host.info,
        cpu_topology: [
          { name: "uniform", kind: "uniform", cores, dvfs_mhz: [] },
        ],
      },
    }))
  );
}

function assertCpuStats(held: Record<string, number | null>, linux: boolean) {
  const pct1 = (value: number) => formatPercent(value, { decimals: 1 });
  const total = reading(held, "cpu.total");
  expectStat("Total", formatPercent(total));
  expectStat("User", pct1(reading(held, "cpu.user")));
  expectStat("System", pct1(reading(held, "cpu.system")));
  expectStat(
    "Load avg",
    ["1", "5", "15"]
      .map((window) => fixed(reading(held, `cpu.loadavg{window=${window}}`), 2))
      .join(" · ")
  );
  if (linux) {
    expectStat("I/O wait", pct1(reading(held, "cpu.iowait")));
    expectStat("Steal", pct1(reading(held, "cpu.steal")));
    expectStat(
      "Pressure stall",
      `${pct1(reading(held, "cpu.psi{stall=some}"))} · full ${pct1(reading(held, "cpu.psi{stall=full}"))}`
    );
    expectStat("Idle", pct1(100 - total - reading(held, "cpu.iowait")));
  } else {
    expectStat("Idle", pct1(100 - total));
    for (const label of ["I/O wait", "Steal", "Pressure stall"])
      expect(screen.queryByLabelText(label)).not.toBeOnTheScreen();
  }
}

// The 300 pt card layoutChart reports, less padding and the label and reading
// columns at the test renderer's font scale of 2, fits this many 10 pt cells
// with 2 pt gaps.
const HEAT_COLUMNS = 11;

test("Mac CPU shows its live and range figures, two ramp series, and performance then efficiency cores", async () => {
  const transport = createMockTransport({ autoTick: false });
  const current = watchHeld(transport);
  const history = watchHistory(transport);
  await openModule(transport, "cpu");
  const held = await current();
  expect(
    await screen.findByText(
      "Apple M4 Pro · 10 performance + 4 efficiency cores"
    )
  ).toBeOnTheScreen();
  assertCpuStats(held, false);

  await layoutChart();
  await layoutChart("core-heatmap-layout");
  const matrix = await screen.findByRole("image", {
    name: /Per-core load.*10 performance cores, 4 efficiency cores.*each column/,
  });
  const ids = [
    ...Array.from({ length: 10 }, (_, i) => `P${i}`),
    ...Array.from({ length: 4 }, (_, i) => `E${i}`),
  ];
  const labels = within(matrix).getAllByText(/^[PE]\d+$/);
  expect(labels).toHaveLength(ids.length);
  for (const [i, id] of ids.entries()) expect(labels[i]).toHaveTextContent(id);
  expect(matrix).toHaveAccessibilityValue({
    text: ids
      .map(
        (id) => `${id} ${formatPercent(reading(held, `cpu.load{core=${id}}`))}`
      )
      .join(", "),
  });
  expect(screen.getByText("−15 min")).toBeOnTheScreen();
  expect(screen.getByText("−7 min")).toBeOnTheScreen();
  expect(history.read).toHaveBeenCalledTimes(2);
  expect(history.read).toHaveBeenCalledWith(
    expect.objectContaining({
      events_for: "cpu",
      series: ["cpu.total", "cpu.system"].map((metric) => ({
        metric,
        labels: [],
      })),
    })
  );
  expect(history.read).toHaveBeenCalledWith(
    expect.objectContaining({
      events_for: null,
      series: ids.map((id) => ({ metric: "cpu.load", labels: [["core", id]] })),
      max_points: HEAT_COLUMNS,
    })
  );
  const total = history.replies
    .flatMap(({ stats }) => stats)
    .find(({ key }) => key.metric === "cpu.total");
  if (!total || total.avg === null || total.peak === null)
    throw new Error("Missing CPU range statistics");
  expectStat("Avg", formatPercent(total.avg, { decimals: 1 }));
  expectStat("Peak", formatPercent(total.peak));
  const chart = screen.getByRole("adjustable", { name: "CPU history" });
  await fireEvent(chart, "accessibilityAction", {
    nativeEvent: { actionName: "increment" },
  });
  expect(
    screen.getByRole("adjustable", { name: "CPU history" })
  ).toHaveAccessibilityValue({ text: /Total: .*System: / });
  expect(screen.getAllByLabelText(/^(Xcode|WindowServer|Figma)$/)).toEqual(
    ["Xcode", "WindowServer", "Figma"].map((name) =>
      screen.getByLabelText(name)
    )
  );
  expect(
    screen.queryByText(/Every process|Avg CPU|System and other/)
  ).not.toBeOnTheScreen();
});

test("Linux shows the OS-specific readings and one set of cores on a uniform CPU", async () => {
  const transport = createMockTransport({
    scenarios: ["linux"],
    autoTick: false,
  });
  const ids = ["P0", "P1", "P2", "P3", "E0", "E1", "E2", "E3"];
  uniformTopology(transport, ids);
  const current = watchHeld(transport);
  await openModule(transport, "cpu");
  const held = await current();
  expect(await screen.findByText("Apple M1 · 8 cores")).toBeOnTheScreen();
  assertCpuStats(held, true);
  await layoutChart("core-heatmap-layout");
  const matrix = await screen.findByRole("image", {
    name: /Per-core load.*8 cores in one group.*each column/,
  });
  const labels = within(matrix).getAllByText(/^[PE]\d+$/);
  expect(labels).toHaveLength(ids.length);
  for (const [i, id] of ids.entries()) expect(labels[i]).toHaveTextContent(id);
});

test("a 64-core host draws every row within the heatmap’s column budget", async () => {
  const transport = createMockTransport({
    scenarios: ["linux"],
    autoTick: false,
  });
  const ids = Array.from({ length: 64 }, (_, i) => String(i));
  uniformTopology(transport, ids);
  const original = transport.hostHistory.bind(transport);
  const read = jest
    .spyOn(transport, "hostHistory")
    .mockImplementation(async (request) => {
      if (request.events_for === "cpu") return original(request);
      // Four coarse buckets keep this case focused on the row limit.
      const bucketMs = 15 * MINUTE_MS;
      const reply: HostHistoryPage = {
        tier: "m15",
        bucket_ms: bucketMs,
        complete_to_ms: request.to_ms ?? request.from_ms,
        series: request.series
          .slice(
            0,
            request.series.every(({ metric }) => metric === "cpu.load")
              ? 256
              : 32
          )
          .map((key) => ({
            key,
            hold_ms: 0,
            points: [
              { t: request.from_ms + bucketMs, avg: 15, min: 10, max: 20 },
            ],
          })),
        stats: [],
        events: [],
        gaps: [],
        clamped: [],
      };
      return { status: "ok", data: reply };
    });
  await openModule(transport, "cpu");
  await fireEvent.press(
    await screen.findByRole("tab", { name: "1h, History range" })
  );
  await layoutChart();
  await layoutChart("core-heatmap-layout");
  const matrix = await screen.findByRole("image", {
    name: /Per-core load.*64 of 64 cores with history/,
  });
  expect(within(matrix).getAllByText(/^\d+$/)).toHaveLength(64);
  expect(matrix).toHaveAccessibilityValue({
    text: ids.map((id) => `${id} —`).join(", "),
  });
  expect(read).toHaveBeenCalledWith(
    expect.objectContaining({ max_points: HEAT_COLUMNS })
  );
});

test("a wider heatmap card asks for more columns so cells stay square", async () => {
  const transport = createMockTransport({ autoTick: false });
  uniformTopology(transport, ["P0"]);
  const { read } = watchHistory(transport);
  await openModule(transport, "cpu");
  await layoutChart();
  await layoutChart("core-heatmap-layout", 600);
  await waitFor(() =>
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ events_for: null, max_points: 36 })
    )
  );
});

test("the CPU chart and heatmap refresh when returning to the cached 15-minute range", async () => {
  const transport = createMockTransport({ autoTick: false });
  uniformTopology(transport, ["P0"]);
  const { read } = watchHistory(transport);
  await openModule(transport, "cpu");
  await layoutChart();
  await layoutChart("core-heatmap-layout");
  expect(
    await screen.findByRole("image", { name: /Per-core load.*each column/ })
  ).toBeOnTheScreen();
  await selectMoreRange("Last 5 minutes");
  await waitFor(() => expect(read).toHaveBeenCalledTimes(4));
  for (const [request] of read.mock.calls)
    expect(request.host).toBe(MOCK_HOST_ID);
  const rangeRequests = (start: number) =>
    read.mock.calls
      .slice(start)
      .map(([{ events_for, max_points, from_ms, to_ms }]) => ({
        events: events_for,
        ...(events_for === null && { budget: max_points }),
        window: (to_ms ?? 0) - from_ms,
      }));
  expect(rangeRequests(2)).toEqual(
    expect.arrayContaining([
      { events: null, budget: HEAT_COLUMNS, window: 5 * MINUTE_MS },
      { events: "cpu", window: 5 * MINUTE_MS },
    ])
  );
  await fireEvent.press(
    screen.getByRole("tab", { name: "15m, History range" })
  );
  await waitFor(() => expect(read).toHaveBeenCalledTimes(6));
  expect(rangeRequests(4)).toEqual(
    expect.arrayContaining([
      { events: null, budget: HEAT_COLUMNS, window: 15 * MINUTE_MS },
      { events: "cpu", window: 15 * MINUTE_MS },
    ])
  );
});

test("an unsupported per-core read leaves the CPU chart usable and identifies the affected host", async () => {
  const transport = createMockTransport({ autoTick: false });
  // failNext cannot pick a request, and only the per-core read fails here.
  const original = transport.hostHistory.bind(transport);
  jest.spyOn(transport, "hostHistory").mockImplementation((request) =>
    request.events_for === "cpu"
      ? original(request)
      : Promise.resolve({
          status: "error",
          error: {
            kind: "remote_unsupported",
            message: "History is unsupported",
          },
        })
  );
  await openModule(transport, "cpu");
  await layoutChart();
  await layoutChart("core-heatmap-layout");
  expect(
    await screen.findByText(/^Update StatGlass on .* to see history$/)
  ).toBeOnTheScreen();
  expect(
    screen.getByRole("adjustable", { name: "CPU history" })
  ).toBeOnTheScreen();
  expect(screen.queryByText("No samples in this range")).not.toBeOnTheScreen();
  expect(
    screen.queryByRole("image", { name: /Per-core load/ })
  ).not.toBeOnTheScreen();
});

test("a measured per-core bucket remains visible when a short pause crosses it", async () => {
  const transport = createMockTransport({ autoTick: false });
  uniformTopology(transport, ["P0"]);
  jest
    .spyOn(transport, "hostHistory")
    .mockImplementation(async ({ from_ms, to_ms, series }) => ({
      status: "ok",
      data: {
        tier: "m15",
        bucket_ms: 15 * MINUTE_MS,
        complete_to_ms: to_ms ?? from_ms,
        series: series.map((key) => ({
          key,
          hold_ms: 0,
          points: [{ t: from_ms, min: 15, avg: 25, max: 35 }],
        })),
        gaps: [
          {
            start_ms: from_ms + MINUTE_MS,
            end_ms: from_ms + 2 * MINUTE_MS,
            reason: "paused",
            module: null,
          },
        ],
        stats: [],
        events: [],
        clamped: [],
      },
    }));
  await openModule(transport, "cpu");
  await layoutChart("core-heatmap-layout");
  expect(
    await screen.findByRole("image", { name: /1 of 1 cores with history/ })
  ).toBeOnTheScreen();
  expect(screen.queryByText("No samples in this range")).not.toBeOnTheScreen();
  await layoutChart("heat-gap-plot", 200, 80);
  expect(
    await screen.findByRole("note", { name: PAUSE_EXPLANATION })
  ).toBeOnTheScreen();
});

test("CPU explains a silent live stream while retaining historical data", async () => {
  const transport = createMockTransport({ autoTick: false });
  const current = watchHeld(transport);
  await openModule(transport, "cpu");
  await current();
  await layoutChart();
  await act(() => jest.advanceTimersByTimeAsync(3500));
  expect(await screen.findByText("Reconnecting")).toBeOnTheScreen();
  expectStat("Total", "—");
  expect(
    screen.getByRole("adjustable", { name: "CPU history" })
  ).toBeOnTheScreen();
});

test("CPU names a failed topology read without hiding total history", async () => {
  const transport = createMockTransport({ autoTick: false });
  const error = {
    kind: "internal",
    message: "The host list is unavailable.",
  } as const;
  // The roster query retries an internal error once; both attempts fail.
  transport.failNext("listHosts", error);
  transport.failNext("listHosts", error);
  await openModule(transport, "cpu");
  await layoutChart();
  await act(() => jest.advanceTimersByTimeAsync(1100));
  expect(
    await screen.findByRole("alert", {
      name: "Couldn’t load CPU topology. The host list is unavailable.",
    })
  ).toBeOnTheScreen();
  expect(
    screen.getByRole("adjustable", { name: "CPU history" })
  ).toBeOnTheScreen();
});

test("a cached heatmap labels its actual right edge during a refresh", async () => {
  const transport = createMockTransport({ autoTick: false });
  uniformTopology(transport, ["P0"]);
  const original = transport.hostHistory.bind(transport);
  let resume = () => {};
  const read = jest
    .spyOn(transport, "hostHistory")
    .mockImplementationOnce(original)
    .mockImplementation(async (request) => {
      await new Promise<void>((resolve) => {
        resume = resolve;
      });
      return original(request);
    });
  const log = jest.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await openModule(transport, "cpu");
    await layoutChart("core-heatmap-layout");
    expect(await screen.findByText("now")).toBeOnTheScreen();
    const replyEnd = read.mock.calls[0]?.[0].to_ms;
    if (replyEnd == null) throw new Error("Missing requested range end");
    await act(() => jest.advanceTimersByTimeAsync(MINUTE_MS));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(
      screen.getByText(formatHistoryTime(replyEnd, false))
    ).toBeOnTheScreen();
    expect(screen.queryByText("now")).not.toBeOnTheScreen();
  } finally {
    await act(() => resume());
    log.mockRestore();
  }
});
