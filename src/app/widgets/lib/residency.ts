import { formatPercent } from "@core/format";
import { IDLE_STATE, type ResidencyRow } from "@core/residency";
import type { StackBarSegment } from "../stack-bar";

/**
 * Accent strength for the i-th non-idle state of n: 100% for the top state
 * down to 30% for the lowest (four states get 1, .75, .52, .32).
 */
function stateMix(i: number, n: number): string {
  const t = n <= 1 ? 0 : i / (n - 1);
  return `color-mix(in srgb, var(--a) ${(100 - t * 70).toFixed(0)}%, transparent)`;
}

/**
 * Frequency residency as `StackBar` segments: each busy state a step of the
 * accent in scope, highest first, and idle as the track.
 */
export function residencySegments(
  rows: readonly ResidencyRow[]
): StackBarSegment[] {
  const busy = rows.filter((r) => r.label !== IDLE_STATE).length;
  let i = 0;
  return rows.map((r) => {
    const idle = r.label === IDLE_STATE;
    return {
      key: r.label,
      label: r.label,
      value: formatPercent(r.pct),
      fraction: r.pct / 100,
      step: idle ? "track" : "none",
      ...(idle ? {} : { color: stateMix(i++, busy) }),
    };
  });
}

/** "GPU residency, last 15 min: 1.40 GHz 4%, …, idle 59%". */
export function residencyLabel(
  subject: string,
  rows: readonly ResidencyRow[]
): string {
  return `${subject}: ${rows.map((r) => `${r.label} ${formatPercent(r.pct)}`).join(", ")}`;
}
