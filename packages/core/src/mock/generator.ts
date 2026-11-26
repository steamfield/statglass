/**
 * Seeded series generator for the mock transport. Every series moves around
 * a fixed sample value (the Overview cards, the CPU page's cores and
 * residency, the Power page's zones and power, the popover) the way its kind
 * of load does on a real Mac (`burst.ts`: CPU idles with spikes, network
 * idles between downloads, memory steps). The shapes run on wall-clock time
 * from the ring's start (`anchorMs`), which sits on a calm moment of every
 * shape, so a freshly opened mock window always shows the same figures and
 * history buckets summarise the very rows the ring holds. Series are seeded
 * by their key; series that move together (CPU time, the GPU, memory, a
 * disk's transfers) share a seed, and totals and residency are derived from
 * their parts (`derived-series.ts`).
 */
import {
  HOLD_FACTOR,
  type LiveProcess,
  LOW_DISK_FREE_BYTES,
  METRIC_PERIODS_MS,
  type Module,
  type SeriesKey,
} from "@core/generated/types";
import { seriesKey, seriesKeyString } from "@core/series-key";
import {
  type Shape,
  Shaper,
  type SpanStats,
  scaled,
  shapeSecond,
} from "./burst";
import { clampRound, derive, isDerived } from "./derived-series";
import {
  BACKGROUND_PROCESSES,
  E_CORES,
  IDLE_PROCESSES,
  P_CORES,
  PROCESSES,
  type ScenarioFlags,
  WIDE_LAYOUT_SERIES,
} from "./fixtures";
import { buildLinuxSpecs, LINUX_PROCESSES } from "./linux";
import { rng, seedOf } from "./rng";
import { diskSeed, isAdaptive, isAveraged, shapeOf } from "./series-shapes";

export interface SeriesSpec {
  key: SeriesKey;
  module: Module;
  /** The sample value: what a backfill lands on, and the shape's scale. */
  base: number;
  min?: number;
  max?: number;
  /** How the series moves around `base` (`burst.ts`). */
  shape: Shape;
  /**
   * Units moved per unit of the shape's multiplier; `base` when absent. Parts
   * that must keep a sum (free and cached against used) swing negatively.
   */
  swing?: number;
  /**
   * Series on one seed move together (CPU time, memory parts, GPU engines, a
   * disk's ops); the default is the series key's own.
   */
  seed: number;
  /** Sampled every `cadence` ticks (catalog 6.1); `null` in between. */
  cadence: number;
  /**
   * Ticks between samples while no window shows the series: 10 for the
   * engine's adaptive collectors (IOReport, network, disk; D-061), else
   * `cadence`.
   */
  idleCadence: number;
  /**
   * A total over these specs' indices (`net.rx_total`, D-092): the sum of
   * their values on the tick, a gap when any of them is, as the engine's
   * collector computes it.
   */
  sumOf?: number[];
  /**
   * A residency state that is a fixed share of this spec's value (its
   * cluster's active %, the GPU's utilisation): `base` over that one's `base`.
   */
  shareOf?: number;
  /** The idle state: what these states leave of 100%. */
  restOf?: number[];
  /**
   * A collector with a period in time, not ticks (`self.cpu`'s catalog
   * period, `METRIC_PERIODS_MS`): it
   * samples every `periodMs` or every tick, whichever is slower, as the
   * engine does.
   */
  periodMs?: number;
  /**
   * Part of `base` that is work done per tick at 1 s, so it scales with the
   * tick rate (StatGlass's own CPU); the rest does not.
   */
  perTick?: number;
  /**
   * In the layout but never sampled: a container that has exited and not yet
   * left the collector's membership (`linux/cgroup.rs`), a gap on every tick.
   */
  silent?: boolean;
}

const GHZ = 1e9;

/** P cores, then E cores, current % load. */
const CORE_LOAD = [34, 22, 41, 18, 12, 9, 27, 15, 8, 6, 52, 38, 44, 29];

/**
 * "Cluster residency", % of the last 60 s per DVFS state. The active states
 * sum to the cluster's active %, and the GPU's to its utilisation.
 */
const RESIDENCY: Record<string, Record<string, number>> = {
  P0: { 4512: 4, 3864: 9, 3204: 18, 2420: 10, 1924: 0, 1260: 0, idle: 59 },
  E0: { 2892: 6, 2160: 11, 1500: 0, 1020: 42, idle: 41 },
};

/** "SoC thermal zones", hottest first. */
const ZONES: [string, number][] = [
  ["PMU tdie4", 61],
  ["PMU tdie1", 59],
  ["PMU tdie6", 58],
  ["PMU2 tdie2", 56],
  ["PMU tdie3", 55],
  ["PMU2 tdie1", 53],
  ["PMU tdie5", 52],
  ["PMU2 tdie4", 50],
  ["PMU tdie2", 49],
  ["PMU2 tdie3", 48],
];

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Existing deterministic fixture scenario logic; split by scenario before removing this local exception (architecture package J).
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Existing deterministic fixture scenario logic; split by scenario before removing this local exception (architecture package J).
export function buildSpecs(flags: ScenarioFlags): SeriesSpec[] {
  const specs: SeriesSpec[] = [];
  const add = (
    module: Module,
    metric: string,
    labels: Record<string, string>,
    base: number,
    opts: Partial<Omit<SeriesSpec, "key" | "module" | "base">> = {}
  ) => {
    const key = seriesKey(metric, labels);
    // Exact optional types keep absent options out of `opts`, not undefined.
    specs.push({
      ...opts,
      key,
      module,
      base,
      min: opts.min ?? 0,
      shape: opts.shape ?? shapeOf(metric),
      seed: opts.seed ?? seedOf(seriesKeyString(key)),
      cadence: opts.cadence ?? 1,
      idleCadence: isAdaptive(metric) ? 10 : (opts.cadence ?? 1),
    });
  };
  // Totals over the reported parts, appended after them as the collectors do.
  const total = (module: Module, metric: string, ...parts: string[]) => {
    const sumOf = specs.flatMap((s, i) =>
      parts.includes(s.key.metric) ? [i] : []
    );
    const base = sumOf.reduce((n, i) => n + (specs[i] as SeriesSpec).base, 0);
    add(module, metric, {}, base, { sumOf });
  };
  if (flags.linux) {
    buildLinuxSpecs(add, total, METRIC_PERIODS_MS["self.cpu"]);
    return specs;
  }
  const pct = { min: 0, max: 100 };
  // Active states are shares of `source`'s value; idle is what they leave.
  const residency = (
    module: Module,
    metric: string,
    labels: Record<string, string>,
    states: [string, number][],
    source: number
  ) => {
    const active: number[] = [];
    for (const [state, v] of states) {
      const derived =
        state === "idle" ? { restOf: active } : { shareOf: source };
      if (state !== "idle") active.push(specs.length);
      add(module, metric, { ...labels, state }, v, { ...pct, ...derived });
    }
  };

  // CPU. Total, user and system are on one seed, so the parts sum to it.
  add("cpu", "cpu.total", {}, 18, { seed: 5, min: 1, max: 100 });
  add("cpu", "cpu.user", {}, 12.4, { seed: 5, ...pct });
  add("cpu", "cpu.system", {}, 5.6, { seed: 5, ...pct });
  [...P_CORES, ...E_CORES].forEach((core, i) => {
    add("cpu", "cpu.load", { core }, CORE_LOAD[i] ?? 10, {
      ...pct,
    });
  });
  for (const [window, v] of [
    ["1", 3.42],
    ["5", 3.1],
    ["15", 2.88],
  ] as const) {
    add("cpu", "cpu.loadavg", { window }, v, { cadence: 5 });
  }
  add("cpu", "cpu.cluster.freq", { cluster: "P0" }, 3.2 * GHZ, {
    min: 1.26 * GHZ,
    max: 4.512 * GHZ,
  });
  add("cpu", "cpu.cluster.freq", { cluster: "E0" }, 1.02 * GHZ, {
    min: 1.02 * GHZ,
    max: 2.892 * GHZ,
  });
  add("cpu", "cpu.cluster.active", { cluster: "P0" }, 41, {
    ...pct,
  });
  add("cpu", "cpu.cluster.active", { cluster: "E0" }, 59, {
    ...pct,
  });
  add("cpu", "cpu.cluster.power", { cluster: "P0" }, 5.8);
  // SMC CPU power (D-054) has no E-cluster key, so no E-cluster series.
  if (flags.cpuPowerSource === null) {
    add("cpu", "cpu.cluster.power", { cluster: "E0" }, 0.6);
  }
  for (const [cluster, states] of Object.entries(RESIDENCY)) {
    const active = specs.findIndex(
      (s) =>
        s.key.metric === "cpu.cluster.active" &&
        s.key.labels.some(([k, v]) => k === "cluster" && v === cluster)
    );
    residency(
      "cpu",
      "cpu.cluster.residency",
      { cluster },
      Object.entries(states),
      active
    );
  }

  // GPU, on seed 9.
  add("gpu", "gpu.util", {}, 36, { seed: 9, min: 1, max: 100 });
  // The engines and the clock move with utilisation.
  add("gpu", "gpu.render", {}, 28, { seed: 9, ...pct });
  add("gpu", "gpu.tiler", {}, 8, { seed: 9, ...pct });
  add("gpu", "gpu.freq", {}, 1.1 * GHZ, {
    seed: 9,
    min: 0.338 * GHZ,
    max: 1.6 * GHZ,
  });
  residency(
    "gpu",
    "gpu.residency",
    {},
    [
      ["1578", 5],
      ["1398", 9],
      ["1098", 14],
      ["720", 8],
      ["idle", 64],
    ],
    specs.findIndex((s) => s.key.metric === "gpu.util")
  );

  // Memory, in bytes (decimal GB). On one seed, app + wired + compressed
  // stays used, and cached and free give up what used takes.
  const mem = { seed: 17 };
  const used = 17.6e9;
  const spare = (v: number) => ({ ...mem, swing: (-used * v) / 6.4e9 });
  add("memory", "mem.used", {}, used, mem);
  add("memory", "mem.app", {}, 11.6e9, mem);
  add("memory", "mem.wired", {}, 3.9e9, mem);
  add("memory", "mem.compressed", {}, 2.1e9, mem);
  add("memory", "mem.cached", {}, 4.0e9, spare(4.0e9));
  add("memory", "mem.free", {}, 2.4e9, spare(2.4e9));
  add("memory", "mem.pressure", {}, 42, { ...mem, swing: 84, ...pct });
  add("memory", "mem.pressure_level", {}, 0);
  add("memory", "mem.swap_used", {}, 512e6);
  add("memory", "mem.swap_in", {}, 0);
  add("memory", "mem.swap_out", {}, 0);

  // Power. The GPU's moves with the GPU; the package is the sum.
  add("power", "power.cpu", {}, 6.4);
  add("power", "power.gpu", {}, 3.1, { seed: 9 });
  add("power", "power.ane", {}, 0);
  add("power", "power.dram", {}, 0.9);
  total(
    "power",
    "power.package",
    "power.cpu",
    "power.gpu",
    "power.ane",
    "power.dram"
  );
  add("power", "power.system", {}, 14.8);
  if (flags.cpuPowerSource !== null) {
    add("power", "power.cpu_source", {}, flags.cpuPowerSource);
  }

  // Sensors: hidden on an unknown chip; no fans on a MacBook Air.
  if (!flags.unknownChip) {
    for (const [sensor, v] of ZONES) {
      add("sensors", "thermal.zone", { sensor }, v, { cadence: 5 });
    }
    add("sensors", "thermal.cpu", {}, 61, { cadence: 5 });
    add("sensors", "thermal.gpu", {}, 54, { cadence: 5 });
    add("sensors", "thermal.hottest", {}, 61, { cadence: 5 });
    for (const [name, v] of [
      ["Battery", 31],
      ["SSD (NAND)", 38],
      ["Wi-Fi module", 44],
    ] as const) {
      add("sensors", "thermal.sensor", { name }, v, { cadence: 5 });
    }
    add("sensors", "thermal.state", {}, 0, { cadence: 2 });
    if (!flags.noFans) {
      add("sensors", "fan.rpm", { fan: "0" }, 1840, { cadence: 2 });
      add("sensors", "fan.rpm", { fan: "1" }, 1860, { cadence: 2 });
      add("sensors", "fan.max", { fan: "0" }, 5700, { cadence: 60 });
      add("sensors", "fan.max", { fan: "1" }, 5700, { cadence: 60 });
      add("sensors", "fan.mode", {}, 0, { cadence: 60 });
    }
  }

  // Network on a 2.4 Gb/s Wi-Fi 6E link: `base` is a download or upload
  // burst's rate, over a low idle (`burst.ts`), under the app bursts in
  // net-apps.ts (a 30 MB/s Docker pull every 7 minutes).
  add("network", "net.rx", { iface: "en0" }, 1.6e6);
  add("network", "net.tx", { iface: "en0" }, 0.3e6);
  add("network", "net.link_rate", { iface: "en0" }, 2.4e9, { cadence: 60 });
  if (flags.vpn) {
    add("network", "net.rx", { iface: "en7" }, 2.5e6);
    add("network", "net.tx", { iface: "en7" }, 0.4e6);
    add("network", "net.link_rate", { iface: "en7" }, 1e9, { cadence: 60 });
  }
  total("network", "net.rx_total", "net.rx");
  total("network", "net.tx_total", "net.tx");

  // Disk: 1 TB container, 612 GB free, Data 330 GB, System 58 GB. A device's
  // ops and request time burst with its bytes, on one seed per direction.
  const io = (dev: string, metric: string, base: number) =>
    add("disk", metric, { dev }, base, {
      seed: diskSeed(dev === "disk3" ? 0 : 1, metric.startsWith("disk.write")),
    });
  io(
    "disk3",
    "disk.read",
    flags.diskIoNoOps ? 0 : flags.diskIoComparison ? 420e6 : 220e6
  );
  io(
    "disk3",
    "disk.write",
    flags.diskIoNoOps ? 0 : flags.diskIoComparison ? 90e6 : 48e6
  );
  if (flags.diskIoComparison) {
    io("disk7", "disk.read", 4e6);
    io("disk7", "disk.write", 1e6);
  }
  if (!flags.diskIoUnavailable) {
    const timings = (
      dev: string,
      readOps: number,
      writeOps: number,
      readMs: number,
      writeMs: number
    ) => {
      for (const [metric, value] of [
        ["disk.read_ops", readOps],
        ["disk.write_ops", writeOps],
        ["disk.read_timed_ops", readOps],
        ["disk.write_timed_ops", writeOps],
        ["disk.read_time", readOps * readMs],
        ["disk.write_time", writeOps * writeMs],
      ] as const)
        io(dev, metric, flags.diskIoNoOps ? 0 : value);
    };
    timings("disk3", 5000, 1200, 0.15, 0.3);
    if (flags.diskIoComparison) timings("disk7", 80, 30, 42, 65);
    for (const metric of [
      "disk.read_ops",
      "disk.write_ops",
      "disk.read_timed_ops",
      "disk.write_timed_ops",
      "disk.read_time",
      "disk.write_time",
    ])
      total("disk", `${metric}_total`, metric);
  }
  total("disk", "disk.read_total", "disk.read");
  total("disk", "disk.write_total", "disk.write");
  // Every APFS volume reports its container's figures, and Rust's
  // `disk.used` is total − free (a Data/System split is not
  // measured), so both volumes read 388 GB used.
  // `disk-low-space` puts "/" under LOW_DISK_FREE_BYTES and the Data volume
  // exactly at it, so both sides of Disk's low-space flag can be checked.
  for (const vol of ["/System/Volumes/Data", "/"]) {
    const free = !flags.diskLowSpace
      ? 612e9
      : vol === "/"
        ? 12e9
        : LOW_DISK_FREE_BYTES;
    add("disk", "disk.used", { vol }, 1000e9 - free, { cadence: 60 });
    add("disk", "disk.free", { vol }, free, { cadence: 60 });
    add("disk", "disk.total", { vol }, 1000e9, { cadence: 60 });
  }

  // Battery.
  if (!flags.noBattery) {
    const b = (metric: string, v: number, cadence: number) =>
      add("battery", metric, {}, v, { cadence, min: -100 });
    b("battery.charge", 87, 10);
    b("battery.charging", 0, 10);
    b("battery.external", 0, 10);
    b("battery.time_remaining", 372, 10);
    b("battery.health", 94, 60);
    b("battery.cycles", 212, 60);
    b("battery.capacity_wh", 68.2, 60);
    b("battery.design_wh", 72.6, 60);
    b("battery.power", -14.8, 10);
    b("battery.temp", 31, 10);
  }

  // Mostly per-tick work: 0.4% at 1 s, under 0.05% at 30 s.
  add("cpu", "self.cpu", {}, 0.4, {
    periodMs: METRIC_PERIODS_MS["self.cpu"],
    perTick: 0.37,
  });

  // Without the SMC map, CPU power comes from IOReport's PMP counters and
  // slows down with it; the SMC keys are read every tick (D-054).
  for (const spec of specs) {
    const smc = flags.cpuPowerSource !== null;
    if (spec.key.metric === "power.cpu" && !smc) spec.idleCadence = 10;
    if (spec.key.metric === "cpu.cluster.power" && smc) {
      spec.idleCadence = spec.cadence;
    }
  }

  // A full Mac's layout for the perf gate: series no screen reads, so the
  // cost is the channel's and the ring's, not extra chart work.
  if (flags.wideLayout) {
    for (let i = 0; specs.length < WIDE_LAYOUT_SERIES; i++) {
      add("sensors", "mock.pad", { i: String(i) }, 40);
    }
  }
  return specs;
}

export interface GeneratedRow {
  values: (number | null)[];
  held: (number | null)[];
  /** Ticks between this row's samples of each series. */
  cadences: number[];
}

/**
 * Advances every series one tick at a time. `values` holds what was measured
 * on this tick (null between a slow series' samples); `held` the latest
 * measured value of each series until it is older than its hold
 * (`HOLD_FACTOR` times its period, the engine's `STALE_NUM / STALE_DEN`),
 * then null (D-047).
 */
export class MockGenerator {
  readonly specs: SeriesSpec[];
  readonly keys: SeriesKey[];
  private readonly shapers: Shaper[];
  private readonly last: (number | null)[];
  /** Tick of each series' last sample, and its hold in ticks then. */
  private readonly lastTick: number[];
  private readonly holdTicks: number[];
  /** Series whose reads fail: every tick is a gap. */
  readonly failing = new Set<number>();
  private tick = 0;
  /** Wall-clock time of the last tick, or null before the first. */
  private lastMs: number | null = null;
  /** Scratch for an interval's mean, so a tick allocates nothing for it. */
  private readonly span: SpanStats = { min: 0, avg: 0, max: 0 };
  /**
   * Wall-clock time the shapes' clock starts from (`shapeSecond`): the ring's
   * start, its backfill's last row.
   */
  anchorMs = 0;
  /** No window shows anything: adaptive series run at `idleCadence`. */
  trayOnly = false;
  /** The sampling interval the next tick is taken at. */
  intervalMs = 1000;

  constructor(private readonly flags: ScenarioFlags) {
    this.specs = buildSpecs(flags);
    this.keys = this.specs.map((s) => s.key);
    this.shapers = this.specs.map((s) => new Shaper(s.shape, s.seed));
    this.last = this.specs.map(() => null);
    this.lastTick = this.specs.map(() => 0);
    this.holdTicks = this.specs.map(() => 0);
  }

  seriesPerModule(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of this.specs) out[s.module] = (out[s.module] ?? 0) + 1;
    return out;
  }

  indexOf(key: string): number {
    return this.keys.findIndex((k) => seriesKeyString(k) === key);
  }

  /**
   * One tick, taken at wall-clock `atMs`, or one interval after the last
   * tick when absent or not after it (a test's clock that stands still
   * still sees the series move). `land` samples every series, as a backfill's last row
   * does. Each stage is one pass that allocates only the arrays the row
   * keeps: the phone demo backfills several hosts' rings at once under
   * Hermes, which has no JIT.
   */
  next(land = false, atMs?: number): GeneratedRow {
    const after =
      this.lastMs === null ? this.anchorMs : this.lastMs + this.intervalMs;
    const at =
      atMs === undefined || (this.lastMs !== null && atMs <= this.lastMs)
        ? after
        : atMs;
    this.lastMs = at;
    const sec = shapeSecond(at, this.anchorMs);
    const n = this.specs.length;
    const cadences = new Array<number>(n);
    const values = new Array<number | null>(n);
    for (let i = 0; i < n; i++) {
      const spec = this.specs[i] as SeriesSpec;
      const cadence = this.cadenceOf(spec);
      cadences[i] = cadence;
      values[i] = this.step(i, spec, land || this.tick % cadence === 0, sec);
    }
    for (let i = 0; i < n; i++) {
      const spec = this.specs[i] as SeriesSpec;
      if (
        isDerived(spec) &&
        (land || this.tick % (cadences[i] as number) === 0)
      )
        values[i] = derive(values, spec, this.specs);
    }
    const held = this.hold(values, cadences);
    this.tick++;
    return { values, held, cadences };
  }

  /** One series' reading at shape second `sec`, or null when unread. */
  private step(
    i: number,
    spec: SeriesSpec,
    sampled: boolean,
    sec: number
  ): number | null {
    const readable = sampled && !this.failing.has(i);
    const metric = spec.key.metric;
    if (
      readable &&
      this.flags.networkRateExtremes &&
      (metric === "net.rx" || metric === "net.tx")
    )
      return networkRateAt(this.tick);
    if (!readable || isDerived(spec) || spec.silent) return null;
    const v = scaled(this.multiplier(i, sec), spec.base, spec.swing);
    const paced =
      spec.perTick === undefined
        ? v
        : v - spec.perTick * (1 - 1000 / this.intervalMs);
    return clampRound(paced, spec);
  }

  /**
   * Series `i`'s multiplier on a tick at `sec`. A rate over a slow interval
   * is its collector's counter delta: the mean over the seconds since the
   * last tick, not the value at the instant.
   */
  private multiplier(i: number, sec: number): number {
    const shaper = this.shapers[i] as Shaper;
    const spec = this.specs[i] as SeriesSpec;
    if (this.intervalMs < 2000 || !isAveraged(spec.key.metric))
      return shaper.at(sec);
    return shaper.stats(sec - this.intervalMs / 1000 + 1, sec + 1, this.span)
      .avg;
  }

  /** Records this tick's readings and returns each series' held value. */
  private hold(
    values: readonly (number | null)[],
    cadences: readonly number[]
  ): (number | null)[] {
    const held = new Array<number | null>(values.length);
    for (let i = 0; i < values.length; i++) {
      const v = values[i] as number | null;
      if (v !== null) {
        this.last[i] = v;
        this.lastTick[i] = this.tick;
        this.holdTicks[i] =
          ((cadences[i] as number) * HOLD_FACTOR.num) / HOLD_FACTOR.den;
      }
      held[i] =
        this.tick - (this.lastTick[i] as number) > (this.holdTicks[i] as number)
          ? null
          : (this.last[i] as number | null);
    }
    return held;
  }

  private cadenceOf(spec: SeriesSpec): number {
    if (spec.periodMs !== undefined)
      return Math.max(1, Math.round(spec.periodMs / this.intervalMs));
    return this.trayOnly ? spec.idleCadence : spec.cadence;
  }

  /**
   * `n` rows of history, one interval apart and ending at `anchorMs` with
   * every series sampled. The first `trayOnly` of them were taken with only
   * the tray open.
   */
  backfill(n: number, trayOnly = 0): GeneratedRow[] {
    const rows: GeneratedRow[] = [];
    for (let i = 0; i < n; i++) {
      this.trayOnly = i < trayOnly;
      const at = this.anchorMs - (n - 1 - i) * this.intervalMs;
      rows.push(this.next(i === n - 1, at));
    }
    this.trayOnly = false;
    return rows;
  }

  /**
   * The top processes, then quiet background and idle ones (800 in all, or
   * the Linux host's 320), with a little per-tick jitter.
   */
  processes(): LiveProcess[] {
    const r = rng(7 + this.tick);
    const rows = this.flags.linux
      ? LINUX_PROCESSES
      : [...PROCESSES, ...BACKGROUND_PROCESSES, ...IDLE_PROCESSES];
    return rows.map((p) => ({
      ...p,
      cpu_pct:
        p.cpu_pct === null
          ? null
          : round(Math.max(0, p.cpu_pct * (0.85 + r() * 0.3))),
    }));
  }
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Four ticks per state let held values expire during the failed reads. */
function networkRateAt(tick: number): number | null {
  const phase = tick % 12;
  if (phase < 4) return 0;
  return phase < 8 ? 999e9 : null;
}
