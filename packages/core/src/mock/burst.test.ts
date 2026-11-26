import type { HistoryPoint } from "@core/generated/types";
import { Shaper } from "./burst";
import { MOCK_HOST_ID, scenarioFlags } from "./fixtures";
import { MockGenerator } from "./generator";
import { mockHistory } from "./history";

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

describe("burst shapes in the live stream", () => {
  it("repeats the same series for the same seed, and a backfill lands on the sample values", () => {
    const again = liveRun();
    expect(again.rows).toEqual(live.rows);
    const gen = new MockGenerator(scenarioFlags([]));
    const last = gen.backfill(600, 420).at(-1);
    for (const key of ["cpu.total", "gpu.util", "mem.used", "net.rx_total"])
      expect(last?.values[gen.indexOf(key)]).toBe(
        gen.specs[gen.indexOf(key)]?.base
      );
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
    const quarters = Array.from({ length: gpu.length / 900 }, (_, q) =>
      gpu.slice(q * 900, q * 900 + 900)
    );
    const flat = quarters.filter(
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
      const holder = wide.find((w) => w.t <= p.t && p.t < w.t + 1_800_000);
      // The wide bucket samples its idle noise, so allow that much below.
      expect(holder && value(holder, "max")).toBeGreaterThanOrEqual(
        value(p, "max") - 0.15 * 18
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
