import type {
  HistoryPage,
  HistoryPoint,
  SeriesKey,
} from "@core/generated/types";
import { seriesKeyString } from "@core/series-key";
import { createMockTransport } from "../mock-transport";
import { Shaper, type SpanStats } from "./burst";
import type { Shape } from "./burst-profiles";
import { MOCK_HOST_ID, type ScenarioName, scenarioFlags } from "./fixtures";
import type { SeriesSpec } from "./generator";
import { MockRing } from "./ring";

const NOW = 1_760_000_005_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function transport(scenarios: ScenarioName[] = ["default"]) {
  return createMockTransport({ now: () => NOW, historyRows: 600, scenarios });
}

async function history(
  t: ReturnType<typeof transport>,
  keys: SeriesKey[],
  fromMs: number,
  bucketMs: number,
  toMs = NOW
): Promise<HistoryPage> {
  const res = await t.queryHistory({
    host: MOCK_HOST_ID,
    selectors: keys.map(({ metric, labels }) => ({ metric, labels })),
    from_ms: fromMs,
    to_ms: toMs,
    // Merged 10 s buckets up to a quarter hour, so pages line up with other reads.
    tier: bucketMs < 15 * MIN ? "s10" : "m15",
    max_points: Math.ceil((toMs - fromMs) / bucketMs) + 1,
  });
  if (res.status !== "ok")
    throw new Error(`history read failed: ${JSON.stringify(res.error)}`);
  return res.data;
}

const pointsOf = (page: HistoryPage, key: string) =>
  page.series.find((s) => seriesKeyString(s.key) === key)?.points ?? [];
const field = (p: HistoryPoint | undefined, f: "min" | "avg" | "max") =>
  (p?.[f] ?? Number.NaN) as number;

describe("live rows and history read one clock", () => {
  it("summarises a 10 s bucket inside the backfill from the very rows the ring holds", async () => {
    const ring = new MockRing(scenarioFlags(["default"]), () => NOW, {
      historyRows: 600,
    });
    const t = transport();
    const bucket = Math.floor((NOW - 2 * MIN) / 10_000) * 10_000;
    for (const key of ["cpu.total", "mem.used", "gpu.util"]) {
      const i = ring.gen.indexOf(key);
      const rows = ring.rows
        .filter((r) => r.ts >= bucket && r.ts < bucket + 10_000)
        .map((r) => r.values[i] as number);
      expect(rows.length).toBe(10);
      const page = await history(
        t,
        [ring.gen.keys[i] as SeriesKey],
        bucket,
        10_000,
        bucket + 10_000
      );
      const p = pointsOf(page, key)[0];
      const scale = Math.max(1, Math.abs(rows[0] as number));
      expect(
        Math.abs(field(p, "min") - Math.min(...rows)) / scale
      ).toBeLessThan(1e-3);
      expect(
        Math.abs(field(p, "max") - Math.max(...rows)) / scale
      ).toBeLessThan(1e-3);
      const avg = rows.reduce((n, v) => n + v, 0) / rows.length;
      expect(Math.abs(field(p, "avg") - avg) / scale).toBeLessThan(1e-3);
    }
  });
});

describe("a span's min, average and max", () => {
  /** The true extremes and mean over each second of `[a, b)`. */
  function perSecond(shaper: Shaper, a: number, b: number): SpanStats {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    for (let s = a; s < b; s++) {
      const v = shaper.at(s);
      min = Math.min(min, v);
      max = Math.max(max, v);
      sum += v;
    }
    return { min, avg: sum / (b - a), max };
  }
  // How far a sampled span may sit inside the true extremes: the core's noise.
  const slack: Record<Exclude<Shape, "constant">, number> = {
    load: 0.25,
    download: 0.05,
    upload: 0.06,
    disk: 0.05,
    level: 0.02,
    gpu: 0.07,
    plateau: 0.025,
    thermal: 0.01,
  };

  it.each(Object.entries(slack))(
    "bounds %s tightly over 10 s and 600 s buckets",
    (shape, tolerance) => {
      const shaper = new Shaper(shape as Shape, 1234);
      const out: SpanStats = { min: 0, avg: 0, max: 0 };
      for (let a = 0; a < 6 * 3600; a += 10) {
        const want = perSecond(shaper, a, a + 10);
        shaper.stats(a, a + 10, out);
        expect(out.min).toBeCloseTo(want.min, 9);
        expect(out.max).toBeCloseTo(want.max, 9);
        expect(out.avg).toBeCloseTo(want.avg, 9);
      }
      for (let a = 0; a < (2 * DAY) / 1000; a += 600) {
        const want = perSecond(shaper, a, a + 600);
        shaper.stats(a, a + 600, out);
        expect(out.max).toBeLessThanOrEqual(want.max + 1e-9);
        expect(out.max).toBeGreaterThanOrEqual(want.max - tolerance);
        expect(out.min).toBeGreaterThanOrEqual(want.min - 1e-9);
        expect(out.min).toBeLessThanOrEqual(want.min + tolerance);
        expect(Math.abs(out.avg - want.avg)).toBeLessThan(tolerance);
      }
    }
  );
});

describe("totals in history", () => {
  async function expectSummed(
    scenarios: ScenarioName[],
    total: string,
    parts: (key: SeriesKey) => boolean
  ) {
    const t = transport(scenarios);
    const ring = new MockRing(scenarioFlags(scenarios), () => NOW, {
      historyRows: 60,
    });
    const keys = ring.gen.keys.filter(parts);
    expect(keys.length).toBeGreaterThan(1);
    const totalKey = ring.gen.keys.find((k) => seriesKeyString(k) === total);
    for (const bucket of [10_000, 30 * MIN]) {
      const page = await history(
        t,
        [totalKey as SeriesKey, ...keys],
        NOW - 6 * HOUR,
        bucket
      );
      const sums = pointsOf(page, total);
      expect(sums.length).toBeGreaterThan(10);
      sums.forEach((p, k) => {
        const sum = keys.reduce(
          (n, key) => n + field(pointsOf(page, seriesKeyString(key))[k], "avg"),
          0
        );
        expect(field(p, "avg")).toBeCloseTo(sum, -1);
      });
    }
  }

  it("sums both interfaces' buckets", () =>
    expectSummed(["vpn"], "net.rx_total", (k) => k.metric === "net.rx"));
  it("sums Linux disks' buckets", () =>
    expectSummed(
      ["linux"],
      "disk.read_total",
      (k) => k.metric === "disk.read"
    ));
  it("sums package power's buckets", () =>
    expectSummed(["default"], "power.package", (k) =>
      ["power.cpu", "power.gpu", "power.ane", "power.dram"].includes(k.metric)
    ));
});

describe("other bucketed fixtures follow the live shapes", () => {
  it("reads the Disk I/O page's throughput from disk3's own series, with ops bursting alongside", async () => {
    const t = transport();
    const from = NOW - 30 * MIN;
    const io = await t.queryDiskIo({
      host: MOCK_HOST_ID,
      device: "disk3",
      from_ms: from,
      to_ms: NOW,
      max_points: 180,
    });
    if (io.status !== "ok") throw new Error("disk I/O read failed");
    const key = {
      metric: "disk.read",
      labels: [["dev", "disk3"]],
    } as SeriesKey;
    const page = await history(t, [key], from, io.data.bucket_ms);
    const reads = pointsOf(page, "disk.read{dev=disk3}");
    let compared = 0;
    for (const p of io.data.points) {
      const h = reads.find((r) => r.t === p.t);
      if (!h || p.read_bps === null || p.t + io.data.bucket_ms > NOW) continue;
      compared++;
      expect(p.read_bps).toBeCloseTo(field(h, "avg"), -3);
      expect(p.read_ops_per_sec ?? 0).toBeCloseTo(
        (p.read_bps * 5000) / 220e6,
        1
      );
    }
    expect(compared).toBeGreaterThan(80);
  });

  it("keeps each app's average the mean of its buckets", async () => {
    const t = transport();
    for (const by of ["cpu", "gpu", "memory", "disk", "energy"] as const) {
      const res = await t.queryUsageSeries(
        MOCK_HOST_ID,
        NOW - HOUR,
        NOW,
        by,
        5
      );
      if (res.status !== "ok") throw new Error(`usage ${by} failed`);
      for (const app of res.data.apps) {
        const values = app.values.filter((v): v is number => v !== null);
        if (values.length === 0 || app.avg === null) continue;
        const mean = values.reduce((n, v) => n + v, 0) / values.length;
        expect(Math.abs(mean - app.avg)).toBeLessThan(
          1e-9 * Math.max(1, Math.abs(app.avg))
        );
      }
    }
  });

  it("drifts a constant series the same in a bucket whatever range asks for it", async () => {
    const t = transport();
    const key = { metric: "battery.charge", labels: [] } as SeriesKey;
    const hour = pointsOf(
      await history(t, [key], NOW - HOUR, 10_000),
      "battery.charge"
    );
    const twoHours = pointsOf(
      await history(t, [key], NOW - 2 * HOUR, 10_000),
      "battery.charge"
    );
    expect(hour.length).toBeGreaterThan(300);
    expect(twoHours.slice(-hour.length)).toEqual(hour);
  });
});

/**
 * What is wrong with value `v` of series `s`, or null: not finite, or out of
 * its range. Collected rather than asserted one by one, as a sweep reads
 * millions of values.
 */
function outOfRange(v: number, s: SeriesSpec | undefined): string | null {
  if (!Number.isFinite(v)) return `${v} is not finite`;
  if (v < (s?.min ?? -Infinity) - 1e-6 || v > (s?.max ?? Infinity) + 1e-6)
    return `${v} is outside [${s?.min}, ${s?.max}]`;
  return null;
}

/** Problems with a history point: a field out of range, or min > avg > max. */
function pointProblems(p: HistoryPoint, s: SeriesSpec | undefined): string[] {
  const problems = (["min", "avg", "max"] as const).flatMap((f) => {
    const bad = outOfRange(field(p, f), s);
    return bad ? [`${f} ${bad}`] : [];
  });
  if (field(p, "min") > field(p, "avg") || field(p, "avg") > field(p, "max"))
    problems.push(`${p.min} / ${p.avg} / ${p.max} out of order`);
  return problems;
}

/** Adds `page`'s problems to `problems`; returns how many points it read. */
function pageProblems(
  page: HistoryPage,
  ring: MockRing,
  problems: Set<string>
): number {
  let points = 0;
  for (const s of page.series) {
    const key = seriesKeyString(s.key);
    const spec = ring.gen.specs[ring.gen.indexOf(key)];
    points += s.points.length;
    for (const p of s.points)
      for (const bad of pointProblems(p, spec))
        problems.add(`${page.bucket_ms} ms ${key}: ${bad}`);
  }
  return points;
}

describe("every series in every layout", () => {
  it.each([
    [[] as ScenarioName[]],
    [["vpn"] as ScenarioName[]],
    [["linux"] as ScenarioName[]],
    [["disk-io-comparison"] as ScenarioName[]],
    [["cpu-power-calibrated"] as ScenarioName[]],
  ])("stays finite, in range and ordered: %j", async (scenarios) => {
    const ring = new MockRing(scenarioFlags(scenarios), () => NOW, {
      historyRows: 900,
    });
    const specs = ring.gen.specs;
    const problems = new Set<string>();
    let checked = 0;
    for (const row of ring.rows)
      row.values.forEach((v, i) => {
        if (v === null || v === undefined) return;
        checked++;
        const bad = outOfRange(v, specs[i]);
        if (bad)
          problems.add(
            `live ${seriesKeyString(ring.gen.keys[i] as SeriesKey)}: ${bad}`
          );
      });
    const t = transport(scenarios);
    for (const [from, bucket] of [
      [NOW - HOUR, 10_000],
      [NOW - 30 * DAY, 30 * MIN],
    ] as const) {
      const page = await history(t, ring.gen.keys, from, bucket);
      expect(page.series.length).toBe(specs.length);
      checked += pageProblems(page, ring, problems);
    }
    expect(checked).toBeGreaterThan(100_000);
    expect([...problems].slice(0, 20)).toEqual([]);
  });
});
