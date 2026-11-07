import { DAY_MS, HOUR_MS } from "@core/time-grid";
export const DOCKER_RANGES = {
  "15m": 900_000,
  "1h": HOUR_MS,
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
} as const;
export type DockerRange = keyof typeof DOCKER_RANGES;

/** Router strings are untrusted even in the memory router (back/restore state). */
export function dockerRange(
  raw: string | null,
  fallback: DockerRange
): DockerRange {
  return raw !== null && Object.hasOwn(DOCKER_RANGES, raw)
    ? (raw as DockerRange)
    : fallback;
}

/** Invalid/empty endpoints resume live history instead of sending NaN to Rust. */
export function historyEnd(raw: string | null, offset = 0): number | null {
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw) + offset;
  return Number.isFinite(value) ? value : null;
}
