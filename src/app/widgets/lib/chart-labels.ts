import {
  formatClock,
  formatClockSeconds,
  formatHistoryTime,
} from "@core/format";
import { DAY_MS } from "@core/time-grid";
/**
 * Relative time label for a chart's x axis: "−60s", "−5m", "−24h". Uses the
 * true minus sign.
 */
export function agoLabel(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s <= 0) return "now";
  if (s < 120) return `−${s}s`;
  const m = Math.round(s / 60);
  if (m < 120) return `−${m}m`;
  if (m >= 2880) return `−${Math.round(m / 1440)}d`;
  return `−${Math.round(m / 60)}h`;
}

/**
 * Evenly spaced x-axis labels for a window ending now: `count` labels from
 * "−window" to "now".
 */
export function windowTicks(windowMs: number, count: number): string[] {
  if (count < 2) return ["now"];
  return Array.from({ length: count }, (_, i) =>
    agoLabel((windowMs * (count - 1 - i)) / (count - 1))
  );
}

/** Gridlines of a fixed 0 to 100% chart, a quarter apart. */
export const PERCENT_GRID: readonly number[] = [25, 50, 75, 100];

/** Y tick labels of a fixed 0 to 100% chart, top down, without the unit. */
export const PERCENT_Y_TICKS: readonly { value: number; label: string }[] = [
  100, 75, 50, 25,
].map((v) => ({ value: v, label: String(v) }));

/**
 * Gridlines at half and full height of an autoscaled ceiling, and with
 * `format` the y ticks, top down. A string labels the ceiling with its unit
 * ("4W") and leaves the half bare; a function formats both. `zero` adds a
 * bare "0" tick at the baseline.
 */
export function ceilingAxis(ceiling: number): { gridlines: number[] };
export function ceilingAxis(
  ceiling: number,
  format: string | ((value: number) => string),
  options?: { zero?: boolean }
): { gridlines: number[]; yTicks: { value: number; label: string }[] };
export function ceilingAxis(
  ceiling: number,
  format?: string | ((value: number) => string),
  { zero = false }: { zero?: boolean } = {}
): {
  gridlines: number[];
  yTicks?: { value: number; label: string }[];
} {
  const half = ceiling / 2;
  const gridlines = [half, ceiling];
  if (format === undefined) return { gridlines };
  const label =
    typeof format === "string"
      ? (value: number) => (value === ceiling ? format : String(value))
      : format;
  const yTicks = [
    { value: ceiling, label: label(ceiling) },
    { value: half, label: label(half) },
  ];
  if (zero) yTicks.push({ value: 0, label: "0" });
  return { gridlines, yTicks };
}

/** Live views use the module-page relative axis; paused history names actual times. */
export function historyTicks(
  from: number,
  to: number,
  live: boolean,
  count = 5
): string[] {
  if (live) return windowTicks(to - from, count);
  const span = to - from;
  const format = (t: number) =>
    span >= DAY_MS
      ? formatHistoryTime(t, true)
      : span <= 300_000
        ? formatClockSeconds(t)
        : formatClock(t);
  return Array.from({ length: count }, (_, tick) =>
    format(from + ((to - from) * tick) / Math.max(1, count - 1))
  );
}
