/**
 * Chart fixtures both apps render and the chart models are tested against:
 * the popover's CPU and GPU streams. The desktop gallery and widget tests
 * reach them through `src/app/widgets/lib/sample-props.ts`.
 */
import type { StreamAreaData } from "@core/widget-models/stream-area";

/** A fixed end time for every fixture; any ms epoch would do. */
export const FIXTURE_T_END = 1_759_617_600_000;

/**
 * A seeded random walk: `n` values around `base`, rounded to one decimal
 * and never below 1, the same on every run.
 */
export function seededWalk(
  n: number,
  seed: number,
  base: number,
  noise: number
): number[] {
  let s = seed;
  const r = () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
  let v = base;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    v += (r() - 0.5) * noise;
    v += (base - v) * 0.2;
    out.push(Math.round(Math.max(1, v) * 10) / 10);
  }
  return out;
}

/** The popover CPU card's 60-second stream. */
export const POPOVER_CPU_STREAM = {
  series: [
    { key: "cpu.total", values: seededWalk(60, 5, 18, 9), step: 1 as const },
  ],
  tEndMs: FIXTURE_T_END,
  intervalMs: 1000,
  yMax: 40,
  accent: "cpu" as const,
  height: 52,
  ariaLabel: "CPU, last 60 seconds, 18%",
  ceilingLabel: "40%",
  windowLabel: "60s",
  gridlines: [20],
} satisfies StreamAreaData;

/** The popover GPU card's 60-second stream. */
export const POPOVER_GPU_STREAM = {
  series: [
    { key: "gpu.util", values: seededWalk(60, 9, 36, 10), step: 1 as const },
  ],
  tEndMs: FIXTURE_T_END,
  intervalMs: 1000,
  yMax: 80,
  accent: "gpu" as const,
  height: 40,
  ariaLabel: "GPU, last 60 seconds, 36%",
} satisfies StreamAreaData;
