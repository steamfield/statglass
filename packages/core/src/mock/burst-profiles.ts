/**
 * What each kind of mock series looks like, as data for `burst.ts`. Every
 * value is a multiplier of the series' sample value (`base`), so one profile
 * serves a 6% core and an 18% total alike. The numbers come from an hour of a
 * real M-series MacBook Pro: CPU idles near its sample value with short
 * spikes to 2 to 3.5 times it, network sits at a percent or two of a burst's
 * rate until a download (10 to 40 s) or an upload blip (1 to 5 s), memory
 * holds for minutes then steps by a few GB, and the GPU holds a plateau for
 * a quarter of an hour before a stretch of idle with short spikes.
 */

/**
 * The kind of load a series shows. `constant` never moves; the rest are
 * profiles below.
 */
export type Shape =
  | "constant"
  | "load"
  | "download"
  | "upload"
  | "disk"
  | "level"
  | "gpu"
  | "plateau"
  | "thermal";

/**
 * Episodes on a fixed grid: each `windowS`-second window holds at most one,
 * with probability `chance`, lasting `minS` to `maxS` seconds at a level
 * drawn from `lo` to `hi`, added to the core while it runs.
 */
export interface Layer {
  windowS: number;
  chance: number;
  minS: number;
  maxS: number;
  lo: number;
  hi: number;
  /** Separates this layer's draws from the others' on the same seed. */
  salt: number;
  /**
   * Drawn from the host's shared seed, so every series with this layer sees
   * the same episodes (a busy stretch lifts most cores at once).
   */
  shared?: boolean;
  /** Runs only in a bursty regime (`RegimeCore`). */
  gated?: boolean;
}

/** Idle around `center`, uniform jitter of ±`jitter`. */
export interface IdleCore {
  kind: "idle";
  center: number;
  jitter: number;
}

/** A log-normal looking baseline: `median` times e^(±`spread`). */
export interface BaselineCore {
  kind: "baseline";
  median: number;
  spread: number;
}

/**
 * Steps between offsets of up to ±`amp` every `windowS` seconds, each taking
 * `rampMinS` to `rampMaxS`, with a drift of up to ±`drift` across a window.
 */
export interface StepsCore {
  kind: "steps";
  windowS: number;
  amp: number;
  rampMinS: number;
  rampMaxS: number;
  drift: number;
  jitter: number;
}

/**
 * Regimes of `windowS` seconds: a plateau between `lo` and `hi`, or with
 * probability `burstyChance` an idle at `idle` where gated layers run.
 */
export interface RegimeCore {
  kind: "regime";
  windowS: number;
  burstyChance: number;
  lo: number;
  hi: number;
  idle: number;
  jitter: number;
}

/**
 * `center`, plus `gain` times the shared busy layer's average over the last
 * `lagS` seconds: temperatures follow load late and smoothly.
 */
export interface LagCore {
  kind: "lag";
  center: number;
  gain: number;
  lagS: number;
  jitter: number;
}

export type Core = IdleCore | BaselineCore | StepsCore | RegimeCore | LagCore;

export interface Profile {
  core: Core | null;
  layers: readonly Layer[];
}

/** Sustained work of one to four minutes, shared by every load series. */
export const BUSY: Layer = {
  windowS: 600,
  chance: 0.35,
  minS: 60,
  maxS: 240,
  lo: 0.4,
  hi: 1,
  salt: 10,
  shared: true,
};

const LOAD: Profile = {
  core: { kind: "idle", center: 0.9, jitter: 0.12 },
  layers: [
    BUSY,
    // A quieter stretch than the usual idle.
    {
      windowS: 600,
      chance: 0.3,
      minS: 20,
      maxS: 90,
      lo: -0.3,
      hi: -0.2,
      salt: 20,
      shared: true,
    },
    // Spikes to 2 to 3.5 times the idle, a few seconds to one 20 s bucket.
    {
      windowS: 60,
      chance: 0.25,
      minS: 3,
      maxS: 25,
      lo: 1.2,
      hi: 2.6,
      salt: 30,
      shared: true,
    },
    // Peaks of a second or two that saturate the chip.
    {
      windowS: 600,
      chance: 0.35,
      minS: 1,
      maxS: 2,
      lo: 3.5,
      hi: 5,
      salt: 40,
      shared: true,
    },
    // This series' own work, so cores are not copies of each other.
    { windowS: 90, chance: 0.15, minS: 2, maxS: 10, lo: 0.8, hi: 2, salt: 50 },
  ],
};

const DOWNLOAD: Profile = {
  core: { kind: "baseline", median: 0.012, spread: 1.2 },
  layers: [
    {
      windowS: 240,
      chance: 0.65,
      minS: 10,
      maxS: 40,
      lo: 0.35,
      hi: 1.25,
      salt: 60,
    },
  ],
};

const UPLOAD: Profile = {
  core: { kind: "baseline", median: 0.02, spread: 1 },
  layers: [
    { windowS: 45, chance: 0.45, minS: 1, maxS: 5, lo: 0.2, hi: 0.7, salt: 70 },
  ],
};

const DISK: Profile = {
  core: { kind: "baseline", median: 0.01, spread: 1.4 },
  layers: [
    {
      windowS: 120,
      chance: 0.5,
      minS: 2,
      maxS: 15,
      lo: 0.3,
      hi: 1.2,
      salt: 80,
    },
  ],
};

const LEVEL: Profile = {
  core: {
    kind: "steps",
    windowS: 480,
    amp: 0.08,
    rampMinS: 15,
    rampMaxS: 50,
    drift: 0.006,
    jitter: 0.002,
  },
  layers: [],
};

const GPU: Profile = {
  core: {
    kind: "regime",
    windowS: 1080,
    burstyChance: 0.4,
    lo: 0.85,
    hi: 1.1,
    idle: 0.08,
    jitter: 0.03,
  },
  layers: [
    {
      windowS: 20,
      chance: 0.35,
      minS: 1,
      maxS: 6,
      lo: 1.3,
      hi: 2.2,
      salt: 90,
      gated: true,
    },
  ],
};

const PLATEAU: Profile = {
  core: {
    kind: "regime",
    windowS: 900,
    burstyChance: 0,
    lo: 0.94,
    hi: 1.08,
    idle: 1,
    jitter: 0.01,
  },
  layers: [],
};

const THERMAL: Profile = {
  core: { kind: "lag", center: 0.94, gain: 0.14, lagS: 90, jitter: 0.004 },
  layers: [],
};

export const PROFILES: Record<Shape, Profile> = {
  constant: { core: null, layers: [] },
  load: LOAD,
  download: DOWNLOAD,
  upload: UPLOAD,
  disk: DISK,
  level: LEVEL,
  gpu: GPU,
  plateau: PLATEAU,
  thermal: THERMAL,
};
