import { describe, expect, it } from "vitest";
import {
  advance,
  createHostSampler,
  DEMO_HOSTS,
  formatRate,
  HOUR_LENGTH,
  initialSeries,
  LIVE_LENGTH,
  rateCeiling,
} from "./phone-data";

const live = DEMO_HOSTS.filter((h) => h.enabled);

function firstFrame(id: string) {
  const host = DEMO_HOSTS.find((h) => h.id === id);
  if (!host) throw new Error(`no demo host ${id}`);
  const next = createHostSampler(host);
  return { host, next, series: initialSeries(host, next) };
}

/** Runs of consecutive values above `threshold`, as their lengths. */
function runs(values: readonly number[], threshold: number) {
  const lengths: number[] = [];
  let run = 0;
  for (const v of values) {
    if (v > threshold) run += 1;
    else if (run) {
      lengths.push(run);
      run = 0;
    }
  }
  if (run) lengths.push(run);
  return lengths;
}

describe.each(live.map((h) => h.id))("host %s", (id) => {
  it("starts every visitor on the same full windows", () => {
    const a = firstFrame(id).series;
    expect(firstFrame(id).series).toEqual(a);
    expect(a.cpu).toHaveLength(LIVE_LENGTH);
    expect(a.down).toHaveLength(LIVE_LENGTH);
    expect(a.cpuHour).toHaveLength(HOUR_LENGTH);
  });

  it("keeps readings in range and its cores in step with the total", () => {
    const { host, series } = firstFrame(id);
    for (const v of [...series.cpu, ...series.memory, ...series.gpu]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
    expect(series.cores).toHaveLength(host.cores.p + host.cores.e);
    const meanCore =
      series.cores.reduce((a, b) => a + b, 0) / series.cores.length;
    expect(Math.abs(meanCore - (series.cpu.at(-1) ?? 0))).toBeLessThan(8);
  });

  it("idles with spikes rather than sitting on one level", () => {
    const { series } = firstFrame(id);
    const sorted = [...series.cpu].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1] ?? 0;
    expect(median).toBeLessThan(25);
    expect(Math.max(...series.cpu)).toBeGreaterThan(median + 20);
  });

  it("downloads in bursts that last many seconds and uploads in short blips", () => {
    const { host, next, series } = firstFrame(id);
    // Ten minutes is enough for a few of each.
    let s = series;
    for (let i = 0; i < 600; i += 1) s = advance(s, next());
    const down = [...series.down, ...s.down];
    const up = [...series.up, ...s.up];
    const downRuns = runs(down, host.downPeak / 4);
    const upRuns = runs(up, host.downPeak / 100);
    expect(downRuns.length).toBeGreaterThan(0);
    expect(Math.max(...downRuns)).toBeGreaterThanOrEqual(10);
    expect(upRuns.length).toBeGreaterThan(0);
    expect(Math.max(...upRuns)).toBeLessThanOrEqual(6);
    // Most of the time the link is quiet.
    const quiet = down.filter((v) => v < host.downPeak / 100).length;
    expect(quiet / down.length).toBeGreaterThan(0.6);
  });
});

it("slides the live windows by one second and closes an hour bucket every tenth", () => {
  const { next, series } = firstFrame("macbook-pro");
  let s = series;
  for (let i = 1; i <= 10; i += 1) {
    const sample = next();
    const before = s.cpuHour;
    s = advance(s, sample);
    expect(s.cpu).toHaveLength(LIVE_LENGTH);
    expect(s.cpu.at(-1)).toBe(sample.cpu);
    expect(s.ticks).toBe(i);
    if (i < 10) expect(s.cpuHour).toBe(before);
  }
  expect(s.cpuHour).toHaveLength(HOUR_LENGTH);
  const lastTen = s.cpu.slice(-10).reduce((a, b) => a + b, 0) / 10;
  expect(s.cpuHour.at(-1)).toBeCloseTo(lastTen, 1);
});

it.each([
  [820, "820 B/s"],
  [307_400, "307 KB/s"],
  [22_400, "22.4 KB/s"],
  [97_440_000, "97.4 MB/s"],
])("formats %d bytes per second as %s", (bytes, text) => {
  expect(formatRate(bytes)).toBe(text);
});

it("rounds a rate scale up to the next 1, 2 or 5 step", () => {
  expect(rateCeiling([0, 1_300_000])).toBe(2_000_000);
  expect(rateCeiling([4_200])).toBe(5_000);
  expect(rateCeiling([9_000_000])).toBe(10_000_000);
});
