import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Event,
  HostHistoryRequest,
  SeriesSelector,
} from "../generated/types";
import { createMockTransport } from "../mock-transport";
import { DAY_MS, HOUR_MS } from "../time-grid";
import { unwrap } from "../transport";
import { MOCK_HOST_ID, scenarioFlags } from "./fixtures";
import { buildSpecs } from "./generator";
import { createMockHostHistory } from "./host-history";
import { ok } from "./protocol";

const now = Date.UTC(2026, 10, 25, 15);
const request: HostHistoryRequest = {
  host: MOCK_HOST_ID,
  series: [{ metric: "cpu.total", labels: [] }],
  from_ms: now - HOUR_MS,
  to_ms: now,
  max_points: 200,
  events_for: null,
};

function demo(scenario: "default" | "vpn" | "sleep-gap" = "default") {
  return createMockTransport({ scenarios: [scenario], autoTick: false });
}

beforeEach(() => vi.useFakeTimers({ now }));
afterEach(() => vi.useRealTimers());

describe("mock host history", () => {
  it.each([
    [HOUR_MS, "s10"],
    [DAY_MS, "m1"],
    [7 * DAY_MS, "m15"],
    [30 * DAY_MS, "m15"],
  ])(
    "keeps %i ms of history within the requested point budget",
    async (span, tier) => {
      const transport = demo();
      const page = await unwrap(
        transport.hostHistory({ ...request, from_ms: now - span })
      );
      expect(page.tier).toBe(tier);
      expect(page.series).toHaveLength(1);
      expect(page.series[0]?.points.length).toBeGreaterThan(0);
      expect(page.series[0]?.points.length).toBeLessThanOrEqual(200);
      expect(page.complete_to_ms).toBeLessThanOrEqual(now);
      expect(page.complete_to_ms).toBeGreaterThan(now - page.bucket_ms);
      expect(page.clamped).toEqual([]);
    }
  );

  it("keeps per-interface stats independent of the point budget", async () => {
    const transport = demo("vpn");
    const series = [{ metric: "net.rx", labels: [] }];
    const input = { ...request, series, from_ms: now - 2 * HOUR_MS };
    const page = await unwrap(transport.hostHistory(input));
    const smaller = await unwrap(
      transport.hostHistory({ ...input, max_points: 150 })
    );
    expect(page.stats.length).toBeGreaterThan(1);
    expect(smaller.stats).toEqual(page.stats);
    for (const stat of page.stats) {
      expect(stat.key.labels).not.toHaveLength(0);
      expect(stat.avg).toEqual(expect.any(Number));
      expect(stat.peak).toBeGreaterThanOrEqual(stat.avg ?? 0);
      const single = await unwrap(
        transport.hostHistory({ ...input, series: [stat.key] })
      );
      expect(single.stats).toEqual([stat]);
    }
  });

  it("moves a short range to the tier that still retains it", async () => {
    const to = now - 2 * DAY_MS;
    const page = await unwrap(
      demo().hostHistory({ ...request, from_ms: to - HOUR_MS, to_ms: to })
    );
    expect(page.tier).toBe("m1");
  });

  it("filters event rows to the requested module", async () => {
    const transport = demo();
    const range = { ...request, from_ms: now - DAY_MS };
    const power = await unwrap(
      transport.hostHistory({ ...range, events_for: "power" })
    );
    const cpu = await unwrap(
      transport.hostHistory({ ...range, events_for: "cpu" })
    );
    const network = await unwrap(
      transport.hostHistory({ ...range, events_for: "network" })
    );
    expect(power.events.map(({ detail }) => detail.kind)).toContain(
      "power_spike"
    );
    expect(cpu.events.map(({ detail }) => detail.kind)).toContain(
      "sustained_process"
    );
    expect(cpu.events.map(({ detail }) => detail.kind)).not.toContain(
      "power_spike"
    );
    expect(network.events).toEqual([]);
  });

  it("merges measured points without discarding a slot that ends after a gap", async () => {
    const transport = demo("sleep-gap");
    const fine = await unwrap(
      transport.hostHistory({ ...request, max_points: 360 })
    );
    const coarse = await unwrap(
      transport.hostHistory({ ...request, max_points: 100 })
    );
    const end = fine.gaps[0]?.end_ms;
    if (end == null) throw new Error("The demo needs a closed gap");
    const start =
      request.from_ms +
      Math.floor((end - request.from_ms) / coarse.bucket_ms) * coarse.bucket_ms;
    expect(start).toBeLessThan(end);
    const measured =
      fine.series[0]?.points.filter(
        (point) => point.t >= start && point.t < start + coarse.bucket_ms
      ) ?? [];
    expect(measured.length).toBeGreaterThan(0);
    const resumed = coarse.series[0]?.points.find((point) => point.t === start);
    expect(resumed?.avg).toBeCloseTo(
      measured.reduce((sum, point) => sum + (point.avg ?? 0), 0) /
        measured.length
    );
    expect(coarse.gaps).toEqual(fine.gaps);
  });

  it("clamps the point and selector counts and gives a core-only request its own limit", async () => {
    const transport = demo();
    const core: SeriesSelector = { metric: "cpu.load", labels: [] };
    const cores = Array.from({ length: 300 }, (_, index) => ({
      ...core,
      labels: [["core", String(index)]] as SeriesSelector["labels"],
    }));
    const onlyCores = await unwrap(
      transport.hostHistory({
        ...request,
        series: cores.slice(0, 64),
        max_points: 60,
      })
    );
    expect(onlyCores.clamped).toEqual([]);
    const lotsOfCores = await unwrap(
      transport.hostHistory({ ...request, series: cores, max_points: 60 })
    );
    expect(lotsOfCores.clamped).toEqual([{ kind: "series" }]);
    const mixed = await unwrap(
      transport.hostHistory({
        ...request,
        series: [...request.series, ...cores],
        from_ms: now - 6 * HOUR_MS,
        max_points: 5_000,
      })
    );
    expect(mixed.clamped).toEqual([{ kind: "points" }, { kind: "series" }]);
    expect(mixed.series[0]?.points.length).toBeLessThanOrEqual(500);
  });

  it("returns gaps for a known series without samples and rejects invalid requests", async () => {
    const transport = demo();
    const page = await unwrap(
      transport.hostHistory({
        ...request,
        series: [{ metric: "cpu.load", labels: [["core", "1000"]] }],
        from_ms: now - 7 * DAY_MS,
      })
    );
    expect(page.series).toEqual([]);
    expect(page.gaps.length).toBeGreaterThan(0);
    for (const overrides of [
      { series: [] },
      { to_ms: request.from_ms },
      { series: [{ metric: "fake.metric", labels: [] }] },
    ]) {
      expect(
        await transport.hostHistory({ ...request, ...overrides })
      ).toMatchObject({
        status: "error",
        error: { kind: "invalid_argument" },
      });
    }
  });

  it("reduces the point budget when the answer exceeds the byte cap", async () => {
    const series = buildSpecs(scenarioFlags(["default"]))
      .slice(0, 32)
      .map(({ key }) => key);
    const page = await unwrap(
      demo().hostHistory({
        ...request,
        series,
        from_ms: now - 5_000_000,
        max_points: 500,
      })
    );
    expect(page.clamped).toEqual([{ kind: "bytes" }]);
    expect(page.series).toHaveLength(32);
    expect(page.series[0]?.points.length).toBeLessThanOrEqual(250);
    expect(page.stats).toHaveLength(32);
  });

  it("keeps the newest 200 events of the requested module", async () => {
    const events: Event[] = Array.from({ length: 201 }, (_, index) => ({
      ts_ms: now - HOUR_MS + index * 1000,
      start_ms: now - HOUR_MS + index * 1000,
      detail: { kind: "fans_ramped", from_rpm: 0, to_rpm: 2000 },
      processes: [],
    }));
    const history = createMockHostHistory({
      queryHistory: demo().queryHistory,
      queryEvents: async () => ok(events),
    });
    const page = await unwrap(history({ ...request, events_for: "power" }));
    expect(page.clamped).toEqual([{ kind: "events" }]);
    expect(page.events).toEqual(events.slice(1));
  });
});

describe("mock host history clock and connection", () => {
  it("uses now when the request leaves the end open", async () => {
    const mockNow = now + 2 * HOUR_MS;
    const transport = createMockTransport({
      now: () => mockNow,
      autoTick: false,
    });
    const range = { ...request, from_ms: mockNow - HOUR_MS, to_ms: mockNow };
    const fixed = await unwrap(transport.hostHistory(range));
    const open = await unwrap(transport.hostHistory({ ...range, to_ms: null }));
    expect(open).toEqual(fixed);
    expect(open.complete_to_ms).toBe(mockNow);
  });

  it("ends an open remote history range using the monitored host clock", async () => {
    const transport = createMockTransport({
      now: () => now,
      scenarios: ["hosts-dashboard"],
      autoTick: false,
    });
    const remote = (await transport.listRemoteHosts()).find(
      ({ status }) =>
        status.state === "connected" && (status.clock_offset_ms ?? 0) > 0
    );
    if (!remote)
      throw new Error("The demo needs a connected host with clock skew");
    const end = now + (remote.status.clock_offset_ms ?? 0);
    const page = await unwrap(
      transport.hostHistory({
        ...request,
        host: remote.config.id,
        from_ms: end - HOUR_MS,
        to_ms: null,
      })
    );
    expect(page.complete_to_ms).toBe(end);
    expect(page.series[0]?.points.at(-1)?.t).toBeGreaterThan(now);
  });

  it("returns a connection error for a disconnected remote host", async () => {
    const transport = createMockTransport({
      scenarios: ["hosts-dashboard"],
      autoTick: false,
    });
    const remote = (await transport.listRemoteHosts()).find(
      ({ status }) => status.state === "connected"
    );
    if (!remote) throw new Error("The demo needs a remote host");
    transport.pushRemoteStatus(remote.config.id, {
      state: "offline",
      last_seen_ms: now,
    });
    expect(
      await transport.hostHistory({ ...request, host: remote.config.id })
    ).toMatchObject({
      status: "error",
      error: { kind: "remote_unreachable" },
    });
  });
});
