import type { HistoryPoint } from "@core/generated/types";
import { seriesKeyString } from "@core/series-key";
import { LAND_S, LANDS, Shaper, scaled } from "./burst";
import { isDerived } from "./derived-series";
import {
  MOCK_HOST_ID,
  SCENARIOS,
  type ScenarioName,
  scenarioFlags,
} from "./fixtures";
import { buildSpecs, MockGenerator, type SeriesSpec } from "./generator";
import { mockHistory } from "./history";
import { LINUX_MEM_TOTAL_BYTES } from "./linux";
import { MockRing } from "./ring";

const HOUR_S = 3600;
const NOW = 1_760_000_005_000;

/** Two hours of 1 s ticks with a window open, keyed by series. */
function liveRun(scenarios: Parameters<typeof scenarioFlags>[0] = []) {
  const gen = new MockGenerator(scenarioFlags(scenarios));
  const rows = Array.from({ length: 2 * HOUR_S }, () => gen.next());
  const series = (key: string) => {
    const i = gen.indexOf(key);
    if (i < 0) throw new Error(`no series ${key} in the mock layout`);
    return rows.map((r) => r.values[i] ?? null);
  };
  return { gen, rows, series };
}

const live = liveRun();
const numbers = (vs: (number | null)[]) =>
  vs.filter((v): v is number => v !== null);
const median = (vs: number[]) =>
  [...vs].sort((a, b) => a - b)[Math.floor(vs.length / 2)] ?? Number.NaN;
const mean = (vs: number[]) => vs.reduce((n, v) => n + v, 0) / vs.length;

/** Lengths of the runs of consecutive values above `threshold`. */
function runsAbove(vs: number[], threshold: number): number[] {
  const runs: number[] = [];
  let run = 0;
  for (const v of [...vs, Number.NEGATIVE_INFINITY]) {
    if (v > threshold) run++;
    else if (run > 0) {
      runs.push(run);
      run = 0;
    }
  }
  return runs;
}

function correlation(a: number[], b: number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    const da = (a[i] as number) - ma;
    const db = (b[i] as number) - mb;
    ab += da * db;
    aa += da * da;
    bb += db * db;
  }
  return ab / Math.sqrt(aa * bb);
}

/**
 * What is wrong with how `spec` lands (`LAND_S`): eased more than a quarter of
 * its swing, or out of its range while it eases in. A sample value on its
 * range's bound (the E cluster idling at its lowest frequency) is clamped
 * there whatever the landing, so only its easing is checked.
 */
function landingProblems(spec: SeriesSpec): string[] {
  const key = seriesKeyString(spec.key);
  const shaper = new Shaper(spec.shape, spec.seed);
  const problems: string[] = [];
  if (Math.abs(shaper.landing) > 0.25)
    problems.push(`${key}: lands ${shaper.landing} away`);
  if (spec.base === spec.min || spec.base === spec.max) return problems;
  for (let s = LAND_S - 30; s <= LAND_S + 30; s++) {
    const v = scaled(shaper.at(s), spec.base, spec.swing);
    if (v < (spec.min ?? -Infinity) || v > (spec.max ?? Infinity))
      problems.push(`${key}: ${v} at ${s - LAND_S} s is out of range`);
  }
  return problems;
}

describe("burst shapes in the live stream", () => {
  it("repeats the same series for the same seed", () => {
    const again = liveRun();
    expect(again.rows).toEqual(live.rows);
  });

  it("ends every fresh backfill on the same figures, continuing the shape instead of jumping", () => {
    const ringAt = (now: number) =>
      new MockRing(scenarioFlags(["default"]), () => now, { historyRows: 600 });
    const a = ringAt(1_760_000_005_000);
    const b = ringAt(1_790_123_456_789);
    expect(b.rows.at(-1)?.values).toEqual(a.rows.at(-1)?.values);
    // Calm series ease onto the boards' figures; bursty ones land where they are.
    for (const [key, figure] of [
      ["cpu.total", 18],
      ["mem.used", 17.6e9],
      ["gpu.util", 36],
      ["thermal.hottest", 61],
      ["power.package", 10.4],
    ] as const)
      expect(a.rows.at(-1)?.values[a.gen.indexOf(key)]).toBe(figure);
    for (const key of ["net.rx_total", "disk.read{dev=disk3}", "cpu.total"]) {
      const i = a.gen.indexOf(key);
      const before = a.rows
        .slice(-31, -1)
        .map((r) => r.values[i])
        .filter((v): v is number => v !== null && v !== undefined);
      const last = a.rows.at(-1)?.values[i] as number;
      expect(last).toBeLessThanOrEqual(2 * Math.max(...before));
    }
  });

  it("varies between ticks at a 500 ms interval", () => {
    const gen = new MockGenerator(scenarioFlags([]));
    gen.intervalMs = 500;
    const i = gen.indexOf("cpu.total");
    const values = Array.from({ length: 20 }, () => gen.next().values[i]);
    for (let k = 1; k < values.length; k++)
      expect(values[k]).not.toBe(values[k - 1]);
  });

  it("reports a rate metric's mean over a slow interval, as the collectors do", () => {
    const fast = new MockGenerator(scenarioFlags([]));
    const slow = new MockGenerator(scenarioFlags([]));
    slow.intervalMs = 5000;
    const i = fast.indexOf("cpu.total");
    const perSecond = Array.from(
      { length: 600 },
      () => fast.next().values[i] as number
    );
    for (let j = 0; j < 120; j++) {
      const v = slow.next().values[i] as number;
      if (j === 0) continue;
      const window = perSecond.slice(5 * j - 4, 5 * j + 1);
      expect(v).toBeCloseTo(mean(window), 1);
    }
  });

  it("lands every layout's calm series near its sample value and inside its range", () => {
    const layouts: ScenarioName[][] = [
      [],
      ...SCENARIOS.map((s) => [s]),
      ["linux"],
    ];
    const problems = new Set<string>();
    let checked = 0;
    for (const scenarios of layouts)
      for (const spec of buildSpecs(scenarioFlags(scenarios))) {
        if (isDerived(spec) || !LANDS.has(spec.shape)) continue;
        checked++;
        for (const bad of landingProblems(spec))
          problems.add(`${scenarios.join(",")} ${bad}`);
      }
    expect(checked).toBeGreaterThan(1000);
    expect([...problems].slice(0, 20)).toEqual([]);
  });
});

describe("series that move together in the live stream", () => {
  it("keeps user and system CPU summing to the total", () => {
    const [user, system, total] = ["cpu.user", "cpu.system", "cpu.total"].map(
      live.series
    ) as [(number | null)[], (number | null)[], (number | null)[]];
    let checked = 0;
    total.forEach((t, k) => {
      if (t === null || t >= 100) return;
      checked++;
      expect((user[k] as number) + (system[k] as number)).toBeCloseTo(t, 1);
    });
    expect(checked).toBeGreaterThan(7000);
    const linux = liveRun(["linux"]);
    const parts = ["cpu.user", "cpu.system", "cpu.iowait"].map(linux.series);
    linux.series("cpu.total").forEach((t, k) => {
      if (t === null || t >= 100) return;
      const sum = parts.reduce((n, p) => n + (p[k] as number), 0);
      expect(sum).toBeCloseTo(t, 1);
    });
  });

  it("sums package power from its parts and drives GPU power with the GPU", () => {
    const parts = ["power.cpu", "power.gpu", "power.ane", "power.dram"].map(
      live.series
    );
    live.series("power.package").forEach((p, k) => {
      if (p === null) return;
      expect(p).toBeCloseTo(
        parts.reduce((n, s) => n + (s[k] as number), 0),
        2
      );
    });
    expect(
      correlation(
        numbers(live.series("power.gpu")),
        numbers(live.series("gpu.util"))
      )
    ).toBeGreaterThan(0.9);
  });

  it("keeps residency states summing to 100, idle when the engine idles", () => {
    const gpu = live.series("gpu.util");
    const states = live.gen.keys.flatMap((k, i) =>
      k.metric === "gpu.residency" ? [i] : []
    );
    const idle = live.gen.indexOf("gpu.residency{state=idle}");
    live.rows.forEach((row, k) => {
      const sum = states.reduce((n, i) => n + (row.values[i] as number), 0);
      expect(sum).toBeCloseTo(100, 1);
      if ((gpu[k] as number) < 6) expect(row.values[idle]).toBeGreaterThan(90);
    });
    for (const cluster of ["P0", "E0"]) {
      const of = live.gen.keys.flatMap((k, i) =>
        k.metric === "cpu.cluster.residency" &&
        k.labels.some(([key, v]) => key === "cluster" && v === cluster)
          ? [i]
          : []
      );
      const idleIdx = live.gen.indexOf(
        `cpu.cluster.residency{cluster=${cluster},state=idle}`
      );
      const active = live.series(`cpu.cluster.active{cluster=${cluster}}`);
      live.rows.forEach((row, k) => {
        const sum = of.reduce((n, i) => n + (row.values[i] as number), 0);
        expect(sum).toBeCloseTo(100, 1);
        if ((active[k] as number) < 100)
          expect(100 - (row.values[idleIdx] as number)).toBeCloseTo(
            active[k] as number,
            1
          );
      });
    }
  });

  it("keeps a series' data when a scenario removes an earlier series", () => {
    const smc = liveRun(["cpu-power-calibrated"]);
    for (const key of ["power.cpu", "power.dram", "fan.rpm{fan=0}"])
      expect(smc.series(key)).toEqual(live.series(key));
  });

  it("keeps Linux memory summing to MemTotal", () => {
    const linux = liveRun(["linux"]);
    const [used, cached, free] = ["mem.used", "mem.cached", "mem.free"].map(
      linux.series
    );
    used?.forEach((u, k) => {
      expect(
        (u as number) + (cached?.[k] as number) + (free?.[k] as number)
      ).toBeCloseTo(LINUX_MEM_TOTAL_BYTES, -3);
    });
  });

  it("answers any second the same in any order, so live and history agree", () => {
    const forward = new Shaper("load", 5);
    const backward = new Shaper("load", 5);
    const seconds = Array.from({ length: 1200 }, (_, i) => i * 7);
    const ahead = seconds.map((s) => forward.at(s));
    const behind = [...seconds].reverse().map((s) => backward.at(s));
    expect(behind.reverse()).toEqual(ahead);
  });

  it("idles CPU near its sample value with spikes, peaks and busy stretches", () => {
    const cpu = numbers(live.series("cpu.total"));
    const idle = median(cpu);
    expect(idle).toBeGreaterThan(13);
    expect(idle).toBeLessThan(18);
    expect(Math.min(...cpu)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...cpu)).toBeLessThanOrEqual(100);
    // Spikes above twice the idle, a handful of seconds each, not constant.
    const spikes = runsAbove(cpu, 2 * idle);
    expect(spikes.length).toBeGreaterThan(10);
    expect(cpu.filter((v) => v > 2 * idle).length / cpu.length).toBeLessThan(
      0.15
    );
    expect(Math.max(...cpu)).toBeGreaterThan(90);
    // A busy stretch: a minute averaging well above the idle.
    const minutes = Array.from({ length: cpu.length / 60 }, (_, m) =>
      mean(cpu.slice(m * 60, m * 60 + 60))
    );
    expect(Math.max(...minutes)).toBeGreaterThan(1.4 * idle);
  });

  it("lifts most cores with the total rather than moving them independently", () => {
    const total = numbers(live.series("cpu.total"));
    const cores = live.gen.keys.flatMap((k, i) =>
      k.metric === "cpu.load" ? [i] : []
    );
    const correlated = cores.filter(
      (i) =>
        correlation(
          live.rows.map((r) => r.values[i] as number),
          total
        ) > 0.5
    );
    expect(correlated.length).toBeGreaterThan(cores.length * 0.75);
  });

  it("idles the network far below its bursts, with long downloads and short, frequent uploads", () => {
    const rx = numbers(live.series("net.rx{iface=en0}"));
    const tx = numbers(live.series("net.tx{iface=en0}"));
    expect(median(rx)).toBeLessThan(1.6e6 / 40);
    expect(median(tx)).toBeLessThan(0.3e6 / 20);
    const downloads = runsAbove(rx, 0.15 * 1.6e6);
    const uploads = runsAbove(tx, 0.15 * 0.3e6);
    for (const d of downloads) expect(d).toBeGreaterThanOrEqual(10);
    for (const d of downloads) expect(d).toBeLessThanOrEqual(40);
    for (const u of uploads) expect(u).toBeLessThanOrEqual(5);
    expect(downloads.length).toBeGreaterThan(10);
    expect(uploads.length).toBeGreaterThan(2 * downloads.length);
    expect(Math.max(...rx)).toBeGreaterThan(1e6);
  });

  it("keeps each total the sum of its interfaces", () => {
    const vpn = liveRun(["vpn"]);
    const total = vpn.series("net.rx_total");
    const en0 = vpn.series("net.rx{iface=en0}");
    const en7 = vpn.series("net.rx{iface=en7}");
    total.forEach((v, i) => {
      expect(v).toBeCloseTo((en0[i] as number) + (en7[i] as number), 2);
    });
  });

  it("holds memory steady for minutes and steps it by a GB or more, keeping its parts summed", () => {
    const used = numbers(live.series("mem.used"));
    const minuteRanges = Array.from({ length: used.length / 60 }, (_, m) => {
      const minute = used.slice(m * 60, m * 60 + 60);
      return Math.max(...minute) - Math.min(...minute);
    });
    expect(median(minuteRanges)).toBeLessThan(0.15e9);
    expect(Math.max(...minuteRanges)).toBeGreaterThan(1e9);
    const parts = ["mem.app", "mem.wired", "mem.compressed"].map(live.series);
    const cached = live.series("mem.cached");
    const free = live.series("mem.free");
    used.forEach((v, i) => {
      const sum = parts.reduce((n, p) => n + (p[i] as number), 0);
      expect(sum).toBeCloseTo(v, -3);
      expect(v + (cached[i] as number) + (free[i] as number)).toBeCloseTo(
        24e9,
        -3
      );
    });
  });

  it("holds the GPU on long plateaus, then idles it with short spikes", () => {
    const gpu = numbers(live.series("gpu.util"));
    // Ten-minute windows a minute apart: a plateau holds for one at least.
    const windows = Array.from(
      { length: Math.floor((gpu.length - 600) / 60) },
      (_, q) => gpu.slice(q * 60, q * 60 + 600)
    );
    const flat = windows.filter(
      (q) => Math.max(...q) - Math.min(...q) < 0.15 * 36
    );
    expect(flat.length).toBeGreaterThan(0);
    const idle = gpu.filter((v) => v < 6).length;
    expect(idle).toBeGreaterThan(600);
    expect(runsAbove(gpu, 45).every((r) => r <= 6)).toBe(true);
    expect(runsAbove(gpu, 45).length).toBeGreaterThan(10);
  });

  it("moves temperatures slowly with load instead of jittering", () => {
    const hottest = numbers(live.series("thermal.hottest"));
    let steepest = 0;
    for (let i = 1; i < hottest.length; i++)
      steepest = Math.max(
        steepest,
        Math.abs((hottest[i] as number) - (hottest[i - 1] as number))
      );
    expect(steepest).toBeLessThan(1.5);
    expect(Math.max(...hottest) - Math.min(...hottest)).toBeGreaterThan(3);
  });
});

describe("burst shapes in history", () => {
  const specs = new MockGenerator(scenarioFlags([])).specs;
  const read = (metric: string, fromMs: number, bucketMs: number) =>
    mockHistory(
      {
        host: MOCK_HOST_ID,
        selectors: [{ metric, labels: [] }],
        from_ms: fromMs,
        to_ms: NOW,
        tier: "s10",
        max_points: Math.ceil((NOW - fromMs) / bucketMs) + 1,
      },
      specs,
      [],
      NOW,
      1000
    ).series[0]?.points ?? [];
  const value = (p: HistoryPoint, f: "min" | "avg" | "max") => p[f] as number;

  it("keeps every bucket's min, average and max in order", () => {
    for (const metric of [
      "cpu.total",
      "net.rx_total",
      "net.tx_total",
      "gpu.util",
      "mem.used",
      "mem.free",
      "thermal.hottest",
    ])
      for (const bucket of [10_000, 30 * 60_000])
        for (const p of read(metric, NOW - 24 * HOUR_S * 1000, bucket)) {
          expect(value(p, "min")).toBeLessThanOrEqual(value(p, "avg"));
          expect(value(p, "avg")).toBeLessThanOrEqual(value(p, "max"));
        }
  });

  it("catches in a wide bucket's max the spikes its average hides", () => {
    const from = Math.floor((NOW - 6 * HOUR_S * 1000) / 1_800_000) * 1_800_000;
    const narrow = read("cpu.total", from, 10_000);
    const wide = read("cpu.total", from, 1_800_000);
    const idle = median(narrow.map((p) => value(p, "avg")));
    let spikes = 0;
    for (const p of narrow) {
      if (value(p, "max") < 2 * idle) continue;
      spikes++;
      // The store merges 10 s buckets to fit max_points, so the wide step
      // need not be exactly 30 minutes: the holder is the last one started.
      const holder = [...wide].reverse().find((w) => w.t <= p.t);
      // The wide bucket samples the core's noise rather than reading every
      // second, so allow its range (the load shape's slack in the tightness
      // test, burst-consistency.test.ts) below.
      expect(holder && value(holder, "max")).toBeGreaterThanOrEqual(
        value(p, "max") - 0.25 * 18
      );
    }
    expect(spikes).toBeGreaterThan(20);
    for (const w of wide)
      expect(value(w, "avg")).toBeLessThan(0.6 * value(w, "max"));
  });

  it("reads a bucket the same whatever range asks for it", () => {
    const hour = read("net.rx_total", NOW - HOUR_S * 1000, 10_000);
    const twoHours = read("net.rx_total", NOW - 2 * HOUR_S * 1000, 10_000);
    expect(twoHours.slice(-hour.length)).toEqual(hour);
  });

  it("shows downloads as rare peaks over a low average", () => {
    const rx = read("net.rx_total", NOW - HOUR_S * 1000, 10_000);
    const avg = rx.map((p) => value(p, "avg"));
    expect(median(avg)).toBeLessThan(1.6e6 / 40);
    const bursting = avg.filter((v) => v > 0.15 * 1.6e6).length;
    expect(bursting).toBeGreaterThan(5);
    expect(bursting / avg.length).toBeLessThan(0.2);
  });
});
