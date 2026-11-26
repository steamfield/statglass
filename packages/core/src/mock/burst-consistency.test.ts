import type {
  HistoryPage,
  HistoryPoint,
  SeriesKey,
} from "@core/generated/types";
import { seriesKeyString } from "@core/series-key";
import { createMockTransport } from "../mock-transport";
import { LAND_S, Shaper, type SpanStats } from "./burst";
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

/** Whether `rows` (one series' readings) summarise to history point `p`. */
function expectSummarised(rows: number[], p: HistoryPoint | undefined) {
  const scale = Math.max(1, Math.abs(rows[0] as number));
  const avg = rows.reduce((n, v) => n + v, 0) / rows.length;
  expect(Math.abs(field(p, "min") - Math.min(...rows)) / scale).toBeLessThan(
    1e-3
  );
  expect(Math.abs(field(p, "max") - Math.max(...rows)) / scale).toBeLessThan(
    1e-3
  );
  expect(Math.abs(field(p, "avg") - avg) / scale).toBeLessThan(1e-3);
}

describe("live rows and history read one clock", () => {
  it.each([1000, 2000])(
    "summarises a 10 s bucket inside a %i ms backfill from the very rows the ring holds",
    async (intervalMs) => {
      const ring = new MockRing(scenarioFlags(["default"]), () => NOW, {
        historyRows: 600,
        intervalMs,
      });
      const t = createMockTransport({
        now: () => NOW,
        historyRows: 600,
        intervalMs,
      });
      const bucket = Math.floor((NOW - 2 * MIN) / 10_000) * 10_000;
      for (const key of [
        "cpu.total",
        "mem.used",
        "gpu.util",
        "cpu.loadavg{window=1}",
        "disk.read{dev=disk3}",
        "power.package",
      ]) {
        const i = ring.gen.indexOf(key);
        expect(i).toBeGreaterThanOrEqual(0);
        const rows = ring.rows
          .filter((r) => r.ts >= bucket && r.ts < bucket + 10_000)
          .flatMap((r) => (r.values[i] == null ? [] : [r.values[i] as number]));
        expect(rows.length).toBeGreaterThan(0);
        const page = await history(
          t,
          [ring.gen.keys[i] as SeriesKey],
          bucket,
          10_000,
          bucket + 10_000
        );
        expectSummarised(rows, pointsOf(page, key)[0]);
      }
    }
  );

  it("puts ticks taken at any timer phase on the rows history summarises", async () => {
    let clock = NOW;
    const t = createMockTransport({
      now: () => clock,
      historyRows: 600,
      autoTick: false,
    });
    const keys = ["cpu.total", "gpu.util"];
    let layout: string[] = [];
    const frames = new Map<number, (number | null)[]>();
    const starts: number[] = [];
    await t.subscribeLive(
      MOCK_HOST_ID,
      (msg) => {
        if (msg.kind === "layout") layout = msg.series.map(seriesKeyString);
        if (msg.kind === "frame") frames.set(msg.ts_ms, msg.values);
        if (msg.kind === "backfill") starts.push(msg.start_ms);
      },
      { series: keys.map((metric) => ({ metric, labels: [] })) }
    );
    for (let k = 1; k <= 25; k++) {
      // The timer fires 450 ms into each second the ring started on.
      clock = NOW + k * 1000 + 450;
      t.tick();
    }
    const bucket = NOW + 5000;
    expect(bucket % 10_000).toBe(0);
    for (const key of keys) {
      const j = layout.indexOf(key);
      const rows = [...frames]
        .filter(([ts]) => ts >= bucket && ts < bucket + 10_000)
        .map(([, values]) => values[j] as number);
      expect(rows.length).toBe(10);
      const page = await history(
        t,
        [{ metric: key, labels: [] }],
        bucket,
        10_000,
        bucket + 10_000
      );
      expectSummarised(rows, pointsOf(page, key)[0]);
    }
    // Rows filled for a stretch away longer than the ring stay on its grid.
    starts.length = 0;
    vi.useFakeTimers();
    t.setWindowVisible(false);
    t.fastForward(2 * HOUR);
    t.setWindowVisible(true);
    // The catch-up drains in later tasks.
    await vi.runAllTimersAsync();
    expect(starts.length).toBeGreaterThan(0);
    for (const start of starts) expect((start - NOW) % 1000).toBe(0);
  });

  afterEach(() => {
    vi.useRealTimers();
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

  /** `[a, b)`'s 10 s buckets combined: their extremes, and their mean. */
  function children(shaper: Shaper, a: number, b: number): SpanStats {
    const out: SpanStats = { min: 0, avg: 0, max: 0 };
    const all = { min: Number.POSITIVE_INFINITY, avg: 0, max: -Infinity };
    for (let s = a; s < b; s += 10) {
      shaper.stats(s, s + 10, out);
      all.min = Math.min(all.min, out.min);
      all.max = Math.max(all.max, out.max);
      all.avg += out.avg / ((b - a) / 10);
    }
    return all;
  }

  const shapes: Exclude<Shape, "constant">[] = [
    "load",
    "download",
    "upload",
    "disk",
    "level",
    "gpu",
    "plateau",
    "thermal",
  ];

  it.each(shapes)("reads %s's 10 s buckets second by second", (shape) => {
    const shaper = new Shaper(shape, 1234);
    const out: SpanStats = { min: 0, avg: 0, max: 0 };
    for (let a = 0; a < 6 * 3600; a += 10) {
      const want = perSecond(shaper, a, a + 10);
      shaper.stats(a, a + 10, out);
      expect(out.min).toBeCloseTo(want.min, 9);
      expect(out.max).toBeCloseTo(want.max, 9);
      expect(out.avg).toBeCloseTo(want.avg, 9);
    }
  });

  /** What is wrong with `shaper`'s `[a, a + width)` against its 10 s buckets. */
  function wideProblems(
    shaper: Shaper,
    a: number,
    width: number,
    tolerance = 0.01
  ): string[] {
    const want = children(shaper, a, a + width);
    const out = shaper.stats(a, a + width, { min: 0, avg: 0, max: 0 });
    const span = `${width} s from ${a}`;
    const problems: string[] = [];
    if (out.max < want.max - 1e-9)
      problems.push(`${span}: max ${out.max} under ${want.max}`);
    if (out.min > want.min + 1e-9)
      problems.push(`${span}: min ${out.min} over ${want.min}`);
    if (Math.abs(out.avg - want.avg) > tolerance * Math.max(1, want.avg))
      problems.push(`${span}: avg ${out.avg} not ${want.avg}`);
    return problems;
  }

  it.each(shapes)(
    "keeps %s's wider buckets around their 10 s buckets",
    (shape) => {
      const shaper = new Shaper(shape, 1234);
      const spans: [number, number][] = [];
      for (const width of [600, 1800, 8640])
        for (let a = 0; a < (2 * DAY) / 1000; a += width)
          spans.push([a, width]);
      // Wider than the landing's exact reads, across it.
      for (let a = LAND_S - 9 * 3600; a < LAND_S + 9 * 3600; a += 6 * 3600)
        spans.push([a, 6 * 3600]);
      const problems = spans.flatMap(([a, width]) =>
        wideProblems(shaper, a, width)
      );
      // So wide that fine layers count by their long-run mean: bounds hold,
      // the average is near.
      problems.push(...wideProblems(shaper, 0, 400_000, 0.03));
      expect(problems.slice(0, 10)).toEqual([]);
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
