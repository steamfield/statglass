import type {
  HostHistoryPage,
  HostHistoryRequest,
} from "@core/generated/types";
import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { createMockTransport, type MockTransport } from "@core/mock-transport";
import { MINUTE_MS } from "@core/time-grid";
import type { MirrorBarsData } from "@core/widget-models/mirror-bars";
import type { StreamAreaData } from "@core/widget-models/stream-area";
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
import { ExpoRoot } from "expo-router";
import { getMockContext } from "expo-router/testing-library";
import { useLayoutEffect } from "react";
import { Pressable } from "react-native";
import { useHostLiveSubscription } from "@/data/live";
import { useCompactStream, useNetworkBars } from "@/data/live-stream";
import { usePhoneSettingsActions } from "@/data/phone-settings";
import { LiveCard } from "@/host/live-card";

// Every bucket size here (5 s to 18.75 s) divides 150 s, so the live edge
// closes a bucket and the plot ends at it.
const edge = Math.floor(Date.UTC(2026, 10, 24, 15, 2, 8) / 150_000) * 150_000;
const shortWindow = 5 * MINUTE_MS;
const longWindow = 15 * MINUTE_MS;
const keys = ["cpu.total", "gpu.util", "net.tx_total", "net.rx_total"];
const ringValues = [20, 30, 20_000, 40_000];
const past = [90, 75, 40_000, 80_000];
const layout = 42;
const child = { includeHiddenElements: true };
const noop = () => {};

type ChartData = {
  cpu?: StreamAreaData;
  gpu?: StreamAreaData;
  network?: MirrorBarsData;
};

function StreamData({ card, data }: { card: "cpu" | "gpu"; data: ChartData }) {
  const stream = useCompactStream(MOCK_HOST_ID, {
    seriesKey: card === "cpu" ? "cpu.total" : "gpu.util",
    subject: card === "cpu" ? "CPU" : "GPU",
    accent: card,
    height: 40,
  });
  useLayoutEffect(() => {
    data[card] = stream;
  }, [card, data, stream]);
  return null;
}

function NetworkData({ data }: { data: ChartData }) {
  const bars = useNetworkBars(MOCK_HOST_ID);
  useLayoutEffect(() => {
    data.network = bars;
  }, [data, bars]);
  return null;
}

function Cards({ onlyCpu, data }: { onlyCpu: boolean; data: ChartData }) {
  useHostLiveSubscription(MOCK_HOST_ID);
  const { set } = usePhoneSettingsActions();
  const chrome = {
    host: MOCK_HOST_ID,
    compact: false,
    stale: false,
    totalBytes: null,
    includeBattery: false,
    macOs: true,
    onOpen: noop,
    onToggleDensity: noop,
    onLongPress: noop,
  };
  return (
    <>
      <LiveCard {...chrome} card="cpu" />
      <StreamData card="cpu" data={data} />
      {!onlyCpu && <LiveCard {...chrome} card="gpu" />}
      {!onlyCpu && <StreamData card="gpu" data={data} />}
      {!onlyCpu && <LiveCard {...chrome} card="network" />}
      {!onlyCpu && <NetworkData data={data} />}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Use a five-minute window"
        onPress={() => set({ chartWindowMs: shortWindow })}
      />
    </>
  );
}

function chart(subject: string, minutes: number, busy = false) {
  const card = screen.getByRole("button", { name: new RegExp(`^${subject},`) });
  return within(card).getByRole("image", {
    ...child,
    busy,
    name: new RegExp(`^${subject}.*last ${minutes} minutes`),
  });
}

function historyReply(request: HostHistoryRequest): HostHistoryPage {
  const bucket_ms = longWindow / request.max_points;
  const start = edge - longWindow;
  return {
    tier: "live1s",
    bucket_ms,
    complete_to_ms: request.to_ms ?? edge,
    series: request.series.map((key) => {
      const avg = past[keys.indexOf(key.metric)] ?? 0;
      return {
        key,
        hold_ms: bucket_ms,
        points: [0, 1, 3, request.max_points - 1].map((index) => ({
          t: start + index * bucket_ms,
          avg,
          min: avg,
          max: avg,
        })),
      };
    }),
    gaps: [],
    events: [],
    stats: [],
    clamped: [],
  };
}

async function renderCards(
  transport: MockTransport,
  chartWindowMs: number,
  {
    onlyCpu = false,
    paused = false,
    backfill = true,
    interval = 1000,
    rows: rowCount,
  }: {
    onlyCpu?: boolean;
    paused?: boolean;
    backfill?: boolean;
    interval?: number;
    rows?: number;
  } = {}
) {
  const rows = rowCount ?? shortWindow / interval + 1;
  const data: ChartData = {};
  const routes = getMockContext({
    index: () => <Cards onlyCpu={onlyCpu} data={data} />,
  });
  await renderWithProviders(<ExpoRoot context={routes} location="/" />, {
    transport,
    settings: { chartWindowMs },
  });
  await waitFor(() => expect(transport.subscriberCount()).toBe(1));
  await act(() => {
    transport.push({
      kind: "status",
      interval_ms: interval,
      frame_period_ms: interval,
      paused,
      display_idle: false,
      on_battery: false,
      performance: "off",
      power_source: "adapter",
      primary_iface: null,
    });
    transport.push({
      kind: "layout",
      layout_no: layout,
      series: keys.map((metric) => ({ metric, labels: [] })),
      kinds: ["gauge", "gauge", "rate", "rate"],
    });
    if (!backfill) return;
    transport.push({
      kind: "backfill",
      layout_no: layout,
      timeline: 0,
      interval_ms: interval,
      start_ms: edge - (rows - 1) * interval,
      holds_ms: keys.map(() => interval),
      rows: Array.from({ length: rows }, (_, index) =>
        interval === 1000 && index === rows - 2
          ? keys.map(() => null)
          : ringValues
      ),
    });
  });
  return data;
}

function expectRequest(
  request: HostHistoryRequest | undefined,
  metrics: string[],
  slots: number
) {
  expect(request).toEqual({
    host: MOCK_HOST_ID,
    series: metrics.map((metric) => ({ metric, labels: [] })),
    max_points: slots,
    from_ms: expect.any(Number),
    to_ms: expect.any(Number),
    events_for: null,
  });
  expect((request?.to_ms ?? 0) - (request?.from_ms ?? 0)).toBe(longWindow);
  expect(request?.from_ms).toBeLessThan(edge - shortWindow);
  expect(request?.to_ms).toBeGreaterThanOrEqual(edge);
}

beforeEach(() => {
  jest.useFakeTimers({ now: edge });
  mockAppState();
});

afterEach(() => {
  jest.useRealTimers();
});

test("a ring starting exactly five minutes before the live edge draws CPU and GPU without a history read", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 0 });
  const history = jest.spyOn(transport, "hostHistory");
  const data = await renderCards(transport, shortWindow);
  // Let status and query notifications from the backfill run through the next tick.
  await act(() => jest.advanceTimersByTimeAsync(1000));

  expect(chart("CPU", 5)).toBeOnTheScreen();
  expect(chart("GPU", 5)).toBeOnTheScreen();
  expect(screen.getAllByText("5m", child)).toHaveLength(2);
  expect(data.cpu?.series[0]?.values).toEqual(Array<number>(60).fill(20));
  expect(data.gpu?.series[0]?.values).toEqual(Array<number>(60).fill(30));
  expect(history).not.toHaveBeenCalled();
});

test("a ring one second short of five minutes still fills every bucket and reads no history", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 0 });
  const history = jest.spyOn(transport, "hostHistory");
  const data = await renderCards(transport, shortWindow, { rows: 300 });
  await act(() => jest.advanceTimersByTimeAsync(1000));

  expect(chart("CPU", 5)).toBeOnTheScreen();
  expect(data.cpu?.series[0]?.values).toEqual(Array<number>(60).fill(20));
  expect(history).not.toHaveBeenCalled();
});

test("a ten-second host fills the same five-minute plot with 30 buckets", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 0 });
  const history = jest.spyOn(transport, "hostHistory");
  const data = await renderCards(transport, shortWindow, { interval: 10_000 });
  expect(chart("CPU", 5)).toBeOnTheScreen();
  expect(chart("GPU", 5)).toBeOnTheScreen();
  expect(chart("Network", 5)).toBeOnTheScreen();
  expect(data.cpu?.series[0]?.values).toEqual(Array<number>(30).fill(20));
  expect(data.gpu?.series[0]?.values).toEqual(Array<number>(30).fill(30));
  expect(data.network?.up).toEqual(Array<number>(30).fill(20_000));
  expect(data.network?.down).toEqual(Array<number>(30).fill(40_000));
  expect(data.cpu?.intervalMs).toBe(10_000);
  expect(data.network?.intervalMs).toBe(10_000);
  expect(history).not.toHaveBeenCalled();
});

test("on a paused host with ring data, the history request ends where the plot stops", async () => {
  jest.setSystemTime(edge + 10 * MINUTE_MS);
  const transport = createMockTransport({ autoTick: false, historyRows: 0 });
  const history = jest
    .spyOn(transport, "hostHistory")
    .mockImplementation(async (request) => ({
      status: "ok",
      data: historyReply(request),
    }));
  const data = await renderCards(transport, longWindow, {
    onlyCpu: true,
    paused: true,
  });
  await waitFor(() => expect(history).toHaveBeenCalledTimes(1));
  expect(history.mock.calls[0]?.[0]).toMatchObject({
    from_ms: edge - longWindow,
    to_ms: edge,
  });
  await waitFor(() => expect(data.cpu?.series[0]?.values[0]).toBe(90));
  await act(() => jest.advanceTimersByTimeAsync(MINUTE_MS));
  expect(history).toHaveBeenCalledTimes(1);
  expect(data.cpu?.tEndMs).toBe(edge);
  expect(data.cpu?.series[0]?.values[0]).toBe(90);
  expect(data.cpu?.series[0]?.values.at(-1)).toBe(20);
});

test("a paused host without live rows can draw stored history", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 0 });
  const history = jest
    .spyOn(transport, "hostHistory")
    .mockImplementation(async (request) => ({
      status: "ok",
      data: historyReply(request),
    }));
  const data = await renderCards(transport, longWindow, {
    onlyCpu: true,
    paused: true,
    backfill: false,
  });
  await waitFor(() => {
    expect(history).toHaveBeenCalledTimes(1);
    expect(chart("CPU", 15)).toBeOnTheScreen();
    expect(data.cpu?.series[0]?.values).toEqual([
      90,
      90,
      null,
      90,
      ...Array<null>(55).fill(null),
      90,
    ]);
  });
  expectRequest(history.mock.calls[0]?.[0], ["cpu.total"], 60);
});

test("a 15-minute window draws CPU and GPU history, gaps and live averages, and follows a settings change", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 0 });
  const release = Promise.withResolvers<void>();
  const history = jest
    .spyOn(transport, "hostHistory")
    .mockImplementation(async (request) => {
      await release.promise;
      return { status: "ok", data: historyReply(request) };
    });
  const data = await renderCards(transport, longWindow);
  await waitFor(() => expect(chart("CPU", 15, true)).toBeOnTheScreen());
  expect(chart("GPU", 15, true)).toBeOnTheScreen();
  await act(() => release.resolve());

  function expected(stored: number, recent: number, newest = recent) {
    const buckets = Array<number | null>(60).fill(null);
    buckets[0] = buckets[1] = buckets[3] = stored;
    buckets.fill(recent, 39, 59);
    buckets[59] = newest;
    return buckets;
  }

  await waitFor(() => {
    expect(chart("CPU", 15)).toBeOnTheScreen();
    expect(chart("GPU", 15)).toBeOnTheScreen();
    expect(data.cpu?.series[0]?.values).toEqual(expected(90, 20));
    expect(data.gpu?.series[0]?.values).toEqual(expected(75, 30));
  });
  expect(screen.getAllByText("15m", child)).toHaveLength(2);
  expectRequest(
    history.mock.calls.find(
      ([request]) => request.series[0]?.metric === "cpu.total"
    )?.[0],
    ["cpu.total"],
    60
  );
  expectRequest(
    history.mock.calls.find(
      ([request]) => request.series[0]?.metric === "gpu.util"
    )?.[0],
    ["gpu.util"],
    60
  );

  function frame(seconds: number, cpu: number, gpu: number) {
    return act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
      transport.push({
        kind: "frame",
        layout_no: layout,
        timeline: 0,
        ts_ms: edge + seconds * 1000,
        values: [cpu, gpu, 58_000, 116_000],
        held: [cpu, gpu, 58_000, 116_000],
      });
    });
  }
  // A frame past the edge opens the next fixed bucket: the plot moves one
  // bucket left, history keeps its midpoints, and the new bucket holds the frame.
  function moved(stored: number, recent: number, newest: number) {
    const buckets = Array<number | null>(60).fill(null);
    buckets[0] = buckets[2] = stored;
    buckets.fill(recent, 38, 59);
    buckets[59] = newest;
    return buckets;
  }
  await frame(1, 90, 86);
  expect(data.cpu?.series[0]?.values).toEqual(moved(90, 20, 90));
  expect(data.gpu?.series[0]?.values).toEqual(moved(75, 30, 86));
  expect(data.cpu?.intervalMs).toBe(15_000);
  expect(data.cpu?.tEndMs).toBe(edge + 15_000);

  // Later frames in the same bucket change only the newest slot.
  await frame(2, 40, 36);
  expect(data.cpu?.series[0]?.values).toEqual(moved(90, 20, 65));
  expect(data.gpu?.series[0]?.values).toEqual(moved(75, 30, 61));
  expect(data.cpu?.tEndMs).toBe(edge + 15_000);
  expect(history).toHaveBeenCalledTimes(3);

  await fireEvent.press(
    screen.getByRole("button", { name: "Use a five-minute window" })
  );
  expect(chart("CPU", 5)).toBeOnTheScreen();
  expect(chart("GPU", 5)).toBeOnTheScreen();
  expect(chart("Network", 5)).toBeOnTheScreen();
  expect(screen.getAllByText("5m", child)).toHaveLength(2);
  expect(screen.getByText("40%", child)).toBeOnTheScreen();
  expect(history).toHaveBeenCalledTimes(3);
});

test("a failed history read leaves the older CPU slots blank and the ring visible", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 0 });
  transport.failNext("hostHistory", {
    kind: "remote_unsupported",
    message: "Host is too old to read history.",
  });
  const history = jest.spyOn(transport, "hostHistory");
  const data = await renderCards(transport, longWindow, { onlyCpu: true });
  const request = await waitFor(() => {
    expect(history).toHaveBeenCalled();
    return history.mock.calls[0]?.[0];
  });
  expectRequest(request, ["cpu.total"], 60);
  await waitFor(() => {
    expect(chart("CPU", 15)).toBeOnTheScreen();
    expect(data.cpu?.series[0]?.values).toEqual([
      ...Array<null>(39).fill(null),
      ...Array<number>(21).fill(20),
    ]);
  });
});

test("a failed history refresh keeps the older CPU slots from the last good reply", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 0 });
  const history = jest
    .spyOn(transport, "hostHistory")
    .mockImplementation(async (request) => {
      const reply = historyReply(request);
      const [series] = reply.series;
      const points = Array.from({ length: request.max_points }, (_, index) => ({
        t: edge - longWindow + index * reply.bucket_ms,
        avg: 90,
        min: 90,
        max: 90,
      }));
      return {
        status: "ok",
        data: { ...reply, series: series ? [{ ...series, points }] : [] },
      };
    });
  const data = await renderCards(transport, longWindow, { onlyCpu: true });
  await waitFor(() => expect(data.cpu?.series[0]?.values[0]).toBe(90));

  history.mockImplementation(async () => ({
    status: "error",
    error: { kind: "internal", message: "History read failed." },
  }));
  // Keep the stream live while the minute refresh comes due and fails.
  for (let second = 1; second <= 75; second++) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
      transport.push({
        kind: "frame",
        layout_no: layout,
        timeline: 0,
        ts_ms: edge + second * 1000,
        values: ringValues,
        held: ringValues,
      });
    });
  }
  expect(history.mock.calls.length).toBeGreaterThan(1);
  expect(data.cpu?.series[0]?.values[0]).toBe(90);
  expect(data.cpu?.series[0]?.values.at(-1)).toBe(20);
});

test("Network requests both directions once and draws old and new mirrored bars with gaps", async () => {
  const transport = createMockTransport({ autoTick: false, historyRows: 0 });
  const history = jest
    .spyOn(transport, "hostHistory")
    .mockImplementation(async (request) => ({
      status: "ok",
      data: historyReply(request),
    }));
  const data = await renderCards(transport, longWindow);
  function expected(stored: number, recent: number) {
    const buckets = Array<number | null>(48).fill(null);
    buckets[0] = buckets[1] = buckets[3] = stored;
    return buckets.fill(recent, 31);
  }
  await waitFor(() => {
    expect(chart("Network", 15)).toBeOnTheScreen();
    expect(data.network?.up).toEqual(expected(40_000, 20_000));
    expect(data.network?.down).toEqual(expected(80_000, 40_000));
  });
  expectRequest(
    history.mock.calls.find(([request]) => request.max_points === 48)?.[0],
    keys.slice(2),
    48
  );
  expect(data.network?.intervalMs).toBe(18_750);
  expect(data.network?.tEndMs).toBe(edge);
});
