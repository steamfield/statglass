import type { TrayReadings, TrayUnits } from "@statglass/widgets";
import {
  createCpuSampler,
  createGpuSampler,
  createLevelSampler,
  createRateSampler,
} from "@/lib/live-sample";

/** Spark and GPU history lengths, as the menu bar's own graphs draw them. */
const CPU_HISTORY = 20;
const GPU_HISTORY = 9;
const P_CORES = 6;
const E_CORES = 4;

const round = (v: number, places = 0) => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

/**
 * Simulated menu bar readings for the landing page: seeded CPU, GPU,
 * per-core, memory and network traces (`live-sample.ts`), with temperature and power following the CPU, so every
 * visitor sees the same plausible menu bar. Each call to `next` is one tick.
 */
export function createTraySampler(seed = 7) {
  const cpu = createCpuSampler(seed);
  const gpu = createGpuSampler(seed + 4);
  const mem = createLevelSampler(seed + 30, 58, [40, 80]);
  const down = createRateSampler(seed + 31, {
    idle: 12_000,
    peak: 1_800_000,
    chance: 0.012,
    seconds: [15, 40],
  });
  const up = createRateSampler(seed + 32, {
    idle: 5_000,
    peak: 160_000,
    chance: 0.03,
    seconds: [1, 4],
  });
  const cores = Array.from({ length: P_CORES + E_CORES }, (_, i) =>
    createCpuSampler(seed + 10 + i)
  );
  let cpuHistory: number[] = [];
  let gpuHistory: number[] = [];

  const step = (): TrayReadings => {
    const c = cpu();
    const g = gpu();
    cpuHistory = [...cpuHistory, c].slice(-CPU_HISTORY);
    gpuHistory = [...gpuHistory, g].slice(-GPU_HISTORY);
    const load = cores.map((next) => next());
    return {
      cpu: c,
      gpu: g,
      mem: round(mem(), 1),
      temp: round(44 + c * 0.35),
      power: round(3.5 + c * 0.32 + g * 0.12, 1),
      netUp: round(up()),
      netDown: round(down()),
      diskRate: round(120_000 + c * 8_000),
      diskUsed: 61,
      battery: 82,
      cpuHistory,
      gpuHistory,
      cores: [load.slice(0, P_CORES), load.slice(P_CORES)],
    };
  };

  // Start with full graphs rather than a line growing from the right edge.
  for (let i = 1; i < CPU_HISTORY; i += 1) step();
  return step;
}

/** The app's default units: °C and bytes per second. */
export const UNITS: TrayUnits = {
  temperature: "celsius",
  network: "bytes_per_sec",
};
