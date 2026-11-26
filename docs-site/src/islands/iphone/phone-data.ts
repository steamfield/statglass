import {
  createCpuSampler,
  createGpuSampler,
  createLevelSampler,
  createRateSampler,
  sampleHistory,
  seededRandom,
} from "@/lib/live-sample";

/**
 * Simulated hosts for the iPhone demo. Every series is a seeded walk, so the
 * server render and every visitor start from the same frame, and the phone's
 * screens show plausible numbers without a transport.
 */

export type HostKind = "mac" | "linux";

export interface DemoHost {
  id: string;
  name: string;
  kind: HostKind;
  /** A host turned off in Settings: listed, never connected. */
  enabled: boolean;
  chip: string;
  /** Performance and efficiency cores; Linux hosts list theirs as `p`. */
  cores: { p: number; e: number };
  memoryGb: number;
  gpu: boolean;
  /**
   * Seeds each trace. Chosen so the first minute on screen has a CPU
   * spike, part of a download and an upload blip in it.
   */
  seed: number;
  /** Resting memory use, percent. */
  memoryBase: number;
  /** Peak download, bytes per second. */
  downPeak: number;
}

export const DEMO_HOSTS: readonly DemoHost[] = [
  {
    id: "macbook-pro",
    name: "MacBook Pro",
    kind: "mac",
    enabled: true,
    chip: "Apple M4 Pro",
    cores: { p: 10, e: 4 },
    memoryGb: 24,
    gpu: true,
    seed: 45,
    memoryBase: 64,
    downPeak: 40e6,
  },
  {
    id: "studio",
    name: "studio",
    kind: "mac",
    enabled: false,
    chip: "Apple M2 Max",
    cores: { p: 8, e: 4 },
    memoryGb: 64,
    gpu: true,
    seed: 11,
    memoryBase: 40,
    downPeak: 10e6,
  },
  {
    id: "build",
    name: "build",
    kind: "linux",
    enabled: true,
    chip: "AMD Ryzen 9 7950X",
    cores: { p: 16, e: 0 },
    memoryGb: 64,
    gpu: false,
    seed: 84,
    memoryBase: 30,
    downPeak: 12e6,
  },
  {
    id: "nas",
    name: "nas",
    kind: "linux",
    enabled: true,
    chip: "Intel N100",
    cores: { p: 4, e: 0 },
    memoryGb: 16,
    gpu: false,
    seed: 101,
    memoryBase: 31,
    downPeak: 25e6,
  },
];

/** Samples kept at 1 s: the CPU page's 5-minute window. */
export const LIVE_LENGTH = 300;
/** Samples kept at 10 s: the CPU page's 1-hour window. */
export const HOUR_LENGTH = 360;
/** Columns in the per-core heat matrix, 2 minutes each over the hour. */
export const CORE_BUCKETS = 30;

export interface HostSeries {
  /** CPU percent, 1 s apart, oldest first. */
  cpu: number[];
  /** CPU percent, 10 s apart, oldest first. */
  cpuHour: number[];
  /** Memory used, percent. */
  memory: number[];
  /** Bytes per second. */
  up: number[];
  down: number[];
  /** GPU percent; zeros on hosts without one. */
  gpu: number[];
  /** Per-core load now, percent, performance cores first. */
  cores: number[];
  /** Per-core load over the hour, `CORE_BUCKETS` columns each. */
  coreHour: number[][];
  ticks: number;
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

interface Sample {
  cpu: number;
  memory: number;
  up: number;
  down: number;
  gpu: number;
  cores: number[];
}

/**
 * One host's sampler: each call is the next second. CPU, GPU, memory and
 * the two network directions are independent bursty traces
 * (`live-sample.ts`); the cores follow the total, so a spike lights most of
 * them at once, as it does on a real machine.
 */
export function createHostSampler(host: DemoHost) {
  const cpu = createCpuSampler(host.seed);
  const gpu = createGpuSampler(host.seed + 3);
  const memory = createLevelSampler(host.seed + 5, host.memoryBase, [5, 95]);
  const down = createRateSampler(host.seed + 7, {
    idle: host.downPeak / 2000,
    peak: host.downPeak,
    chance: 0.008,
    seconds: [12, 35],
  });
  const up = createRateSampler(host.seed + 9, {
    idle: host.downPeak / 4000,
    peak: host.downPeak / 25,
    chance: 0.03,
    seconds: [1, 4],
  });
  const rand = seededRandom(host.seed + 101);
  const count = host.cores.p + host.cores.e;
  // Performance cores carry most of the load, efficiency cores the
  // background; weights average 1 so the cores agree with the total.
  const raw = Array.from({ length: count }, (_, i) =>
    i < host.cores.p ? 0.4 + rand() * 1.4 : 1.2 + rand() * 1.6
  );
  const total = raw.reduce((a, b) => a + b, 0);
  const weights = raw.map((w) => (w * count) / total);
  return (): Sample => {
    const load = cpu();
    return {
      cpu: load,
      memory: memory(),
      down: Math.round(down()),
      up: Math.round(up()),
      gpu: host.gpu ? gpu() : 0,
      cores: weights.map((w) =>
        round1(clamp(load * w + (rand() - 0.5) * 6, 0, 100))
      ),
    };
  };
}

const mean = (values: readonly number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

/** The host's first frame: full windows of history ending now. */
export function initialSeries(host: DemoHost, next: () => Sample): HostSeries {
  // The hour comes first so the live window continues from its last bucket.
  const hourSampler = createCpuSampler(host.seed + 57);
  const cpuHour = Array.from({ length: HOUR_LENGTH }, () =>
    round1(mean(sampleHistory(hourSampler, 10)))
  );
  const samples = Array.from({ length: LIVE_LENGTH }, () => next());
  const last = samples.at(-1) as Sample;
  const per = HOUR_LENGTH / CORE_BUCKETS;
  const coreHour = last.cores.map((now, core) =>
    Array.from({ length: CORE_BUCKETS }, (_, b) => {
      const bucket = mean(cpuHour.slice(b * per, (b + 1) * per));
      const ratio = mean(last.cores) > 0 ? now / mean(last.cores) : 1;
      return round1(
        clamp(
          bucket * (0.5 + ratio * 0.5) + ((core * 7 + b * 3) % 9) - 4,
          0,
          100
        )
      );
    })
  );
  return {
    cpu: samples.map((s) => s.cpu),
    cpuHour,
    memory: samples.map((s) => s.memory),
    up: samples.map((s) => s.up),
    down: samples.map((s) => s.down),
    gpu: samples.map((s) => s.gpu),
    cores: last.cores,
    coreHour,
    ticks: 0,
  };
}

const push = (values: readonly number[], value: number) => [
  ...values.slice(1),
  value,
];

/** The series one second later. Every tenth second closes an hour bucket. */
export function advance(series: HostSeries, sample: Sample): HostSeries {
  const ticks = series.ticks + 1;
  const cpu = push(series.cpu, sample.cpu);
  return {
    cpu,
    cpuHour:
      ticks % 10 === 0
        ? push(series.cpuHour, round1(mean(cpu.slice(-10))))
        : series.cpuHour,
    memory: push(series.memory, sample.memory),
    up: push(series.up, sample.up),
    down: push(series.down, sample.down),
    gpu: push(series.gpu, sample.gpu),
    cores: sample.cores,
    coreHour: series.coreHour,
    ticks,
  };
}

/** "97.4 MB/s", "307 KB/s", "820 B/s": decimal units, three figures. */
export function formatRate(bytesPerSecond: number): string {
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let value = Math.max(0, bytesPerSecond);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const text =
    value >= 100 || unit === 0
      ? Math.round(value).toString()
      : value.toFixed(1);
  return `${text} ${units[unit]}`;
}

/** A steady scale ceiling for a rate series: the next 1, 2 or 5 step above its peak. */
export function rateCeiling(values: readonly number[]): number {
  const peak = Math.max(1, ...values);
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  const step = [1, 2, 5, 10].find((m) => m * magnitude >= peak) ?? 10;
  return step * magnitude;
}

/** A percent chart ceiling: the next 10 above the peak, at most 100. */
export function percentCeiling(values: readonly number[]): number {
  return clamp(Math.ceil((Math.max(0, ...values) + 1) / 10) * 10, 10, 100);
}
