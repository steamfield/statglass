import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { LiveMsg } from "../generated/types";
import { historyGrid } from "../history-grid";
import { createMockTransport } from "../mock-transport";
import { MINUTE_MS } from "../time-grid";
import { unwrap } from "../transport";
import { MOCK_HOST_ID } from "./fixtures";
import { phoneDemoOptions } from "./history";

const now = Date.UTC(2026, 10, 25, 15, 0, 41);
const metrics = ["cpu.total", "mem.used", "net.rx_total", "net.tx_total"];
const phoneOptions = phoneDemoOptions({
  scenarios: ["hosts-dashboard"],
  historyRows: 2,
});

function request(host: string, to = now) {
  return {
    host,
    series: metrics.map((metric) => ({ metric, labels: [] })),
    from_ms: to - 30 * MINUTE_MS,
    to_ms: to,
    max_points: 42,
    events_for: null,
  };
}

beforeEach(() => vi.useFakeTimers({ now }));
afterEach(() => vi.useRealTimers());

test("live demo hosts have distinct, repeatable vitals and history", async () => {
  const first = createMockTransport(phoneOptions);
  const second = createMockTransport(phoneOptions);
  const hosts = [MOCK_HOST_ID, "remote-build", "remote-partial"];
  async function readings(transport: typeof first, host: string) {
    const vitals = await unwrap(transport.hostVitals(host));
    const history = await unwrap(transport.hostHistory(request(host)));
    return {
      figures: [
        vitals.cpu_pct,
        vitals.memory_pct,
        vitals.net_rx_bps,
        vitals.net_tx_bps,
      ],
      series: history.series,
    };
  }
  const original = await Promise.all(
    hosts.map((host) => readings(first, host))
  );
  const recreated = await Promise.all(
    hosts.map((host) => readings(second, host))
  );
  expect(recreated).toEqual(original);
  for (const [index, metric] of metrics.entries()) {
    expect(new Set(original.map(({ figures }) => figures[index])).size).toBe(
      hosts.length
    );
    expect(
      new Set(
        original.map(({ series }) =>
          JSON.stringify(
            series.find(({ key }) => key.metric === metric)?.points
          )
        )
      ).size
    ).toBe(hosts.length);
  }
});

test("compact demo history reaches the host clock and only the sleep fixture has a hole", async () => {
  const transport = createMockTransport(phoneOptions);
  const input = request("remote-build", now + 120_000);
  const history = await unwrap(transport.hostHistory(input));
  const grid = historyGrid(history, metrics, input.from_ms, input.to_ms);
  expect(history.gaps).toEqual([]);
  expect(history.complete_to_ms).toBe(input.to_ms);
  for (const values of Object.values(grid.values)) {
    expect(values.length).toBeGreaterThan(20);
    expect(values).not.toContain(null);
  }
  transport.dispose();

  const sleep = createMockTransport(
    phoneDemoOptions({ scenarios: ["sleep-gap"], historyRows: 2 })
  );
  const local = request(MOCK_HOST_ID);
  const slept = await unwrap(sleep.hostHistory(local));
  expect(slept.gaps).toEqual([expect.objectContaining({ reason: "sleep" })]);
  const cpu = historyGrid(slept, metrics, local.from_ms, local.to_ms).values[
    "cpu.total"
  ];
  expect(cpu).toContain(null);
  expect(cpu?.at(-1)).toEqual(expect.any(Number));
});

test("full and compact phone streams use the same seeded readings", async () => {
  const phone = createMockTransport(
    phoneDemoOptions({ ...phoneOptions, autoTick: true })
  );
  const desktop = createMockTransport({
    scenarios: ["hosts-dashboard"],
    historyRows: 2,
    autoTick: true,
  });
  const host = "remote-build";
  const { series } = request(host);
  const full: LiveMsg[] = [];
  const compact: LiveMsg[] = [];
  const defaultReadings: LiveMsg[] = [];
  try {
    await phone.subscribeLive(host, (message) => full.push(message), {
      series,
    });
    await phone.subscribeLive(host, (message) => compact.push(message), {
      series,
      minPeriodMs: 5_000,
      backfillMs: 0,
    });
    await desktop.subscribeLive(
      host,
      (message) => defaultReadings.push(message),
      { series }
    );
    const readings = (messages: LiveMsg[]) =>
      messages.find((message) => message.kind === "backfill")?.rows.at(-1);
    expect(readings(full)).toHaveLength(series.length);
    expect(readings(full)).toEqual(readings(compact));
    expect(readings(full)).not.toEqual(readings(defaultReadings));
    await vi.advanceTimersByTimeAsync(5_000);
    const sample = compact.filter((message) => message.kind === "frame").at(-1);
    expect(sample?.held).toHaveLength(series.length);
    const sameTick = (messages: LiveMsg[]) =>
      messages.find(
        (message) => message.kind === "frame" && message.ts_ms === sample?.ts_ms
      );
    expect(sameTick(full)).toMatchObject({ held: sample?.held });
    expect(sameTick(defaultReadings)).toMatchObject({ ts_ms: sample?.ts_ms });
    expect(sameTick(defaultReadings)).not.toMatchObject({ held: sample?.held });
  } finally {
    phone.dispose();
    desktop.dispose();
  }
});
