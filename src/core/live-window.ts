/**
 * Live chart windows that follow the sampling interval (plan 4.15). A
 * window designed at 1 s keeps its sample count at slower intervals: the
 * popover's 60 s charts hold 60 samples, which at 30 s cover 30 minutes.
 * Faster intervals keep the window (more samples), and no window exceeds the
 * engine's one-hour ring.
 */
import {
  type ChartWindow,
  CHART_WINDOW_MS as PRESET_MS,
  CHART_WINDOWS as PRESETS,
  RING_SPAN_MS,
  DEFAULT_CHART_WINDOW as RUST_DEFAULT,
} from "@core/generated/bindings";
import { samplingPlan } from "@core/sampling-plans";
import { DAY_MS, MINUTE_MS } from "@core/time-grid";

/**
 * Fewest samples a fixed window choice (5m, 15m, 30m, 1h) must hold to be
 * offered. Under this the chart is a few dots: 5m at 60 s is 5 samples.
 */
export const MIN_WINDOW_SAMPLES = 10;

/** `baseMs` (designed for 1 s) stretched to the same sample count at `intervalMs`. */
export function scaledWindowMs(baseMs: number, intervalMs: number): number {
  return Math.min(RING_SPAN_MS, baseMs * Math.max(1, intervalMs / 1000));
}

/** Whether a fixed window holds enough samples at `intervalMs`. The 1 h window always does. */
export function windowAllowed(windowMs: number, intervalMs: number): boolean {
  return (
    windowMs >= RING_SPAN_MS || windowMs / intervalMs >= MIN_WINDOW_SAMPLES
  );
}

/**
 * The module pages' chart window (D-091), shortest first. One choice, saved
 * in settings, applies to every windowed chart on every module page.
 * Rust's `ChartWindow::PRESETS`.
 */
export const CHART_WINDOWS: readonly Extract<ChartWindow, string>[] = PRESETS;

/** The chart window when none is saved or settings could not be read (Rust's default). */
export const DEFAULT_CHART_WINDOW: ChartWindow = RUST_DEFAULT;

/** Each fixed choice's duration (`ChartWindow::preset_ms`). */
export const CHART_WINDOW_MS: Record<
  Extract<ChartWindow, string>,
  number
> = PRESET_MS;

/**
 * The window the pages show for the `saved` choice at `intervalMs`: the
 * saved one when it holds enough samples, otherwise the shortest that does.
 * The saved choice is never overwritten, so it comes back when the interval
 * speeds up again.
 */
export function effectiveWindow(
  saved: ChartWindow,
  intervalMs: number
): ChartWindow {
  if (typeof saved !== "string" && "absolute" in saved) return saved;
  const duration =
    typeof saved === "string" ? CHART_WINDOW_MS[saved] : saved.relative;
  if (windowAllowed(duration, intervalMs)) return saved;
  return (
    CHART_WINDOWS.find((w) => windowAllowed(CHART_WINDOW_MS[w], intervalMs)) ??
    "1h"
  );
}

/**
 * The slowest tick the engine may run at for these settings: its tick on
 * battery from the sampling plans (D-092). Low Power Mode is not a setting;
 * pass it when the caller knows it.
 */
export function slowestIntervalMs(
  sampling: {
    interval_ms: number;
    slow_on_battery: boolean;
    performance_mode?: boolean;
  },
  lowPowerMode = false
): number {
  const plan = samplingPlan({
    interval_ms: sampling.interval_ms,
    slow_on_battery: sampling.slow_on_battery,
    performance: !!sampling.performance_mode || lowPowerMode,
    low_power_mode: lowPowerMode,
  });
  return plan?.battery.tick_ms ?? sampling.interval_ms;
}

/** Corner label for a window: "48s", "60s", "30m", "1h". */
export function windowLabel(ms: number): string {
  if (ms < 120_000) return `${Math.round(ms / 1000)}s`;
  if (ms % DAY_MS === 0) return `${ms / DAY_MS}d`;
  if (ms % RING_SPAN_MS === 0) return `${ms / RING_SPAN_MS}h`;
  return `${Math.round(ms / MINUTE_MS)}m`;
}

/** The same window in words, for accessible names: "60 seconds", "30 minutes", "hour". */
export function windowWords(ms: number): string {
  if (ms < 120_000) return `${Math.round(ms / 1000)} seconds`;
  if (ms % DAY_MS === 0) {
    const days = ms / DAY_MS;
    return days === 1 ? "day" : `${days} days`;
  }
  if (ms % RING_SPAN_MS !== 0) return `${Math.round(ms / MINUTE_MS)} minutes`;
  const h = Math.round(ms / RING_SPAN_MS);
  return h === 1 ? "hour" : `${h} hours`;
}
