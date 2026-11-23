/**
 * A rule's last-fired line on the Alerts page: how long ago the rule last
 * fired, and the Timeline window its link opens. Pure; no React.
 */
import type { ChartWindow } from "@core/generated/bindings";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "@core/time-grid";

/** A Timeline window with fixed bounds. */
export type AbsoluteWindow = Extract<ChartWindow, { absolute: unknown }>;

/** Half the hour the Timeline shows around an alert. */
const HALF_WINDOW_MS = 30 * MINUTE_MS;

/**
 * "Last fired just now" under a minute ago, then whole minutes, hours and
 * days rounded down: "Last fired 5 min ago", "1 h ago", "3 d ago". A time
 * ahead of `nowMs` (clock skew) reads as just now.
 */
export function lastFiredText(firedAtMs: number, nowMs: number): string {
  const agoMs = nowMs - firedAtMs;
  if (agoMs < MINUTE_MS) return "Last fired just now";
  if (agoMs < HOUR_MS)
    return `Last fired ${Math.floor(agoMs / MINUTE_MS)} min ago`;
  if (agoMs < DAY_MS) return `Last fired ${Math.floor(agoMs / HOUR_MS)} h ago`;
  return `Last fired ${Math.floor(agoMs / DAY_MS)} d ago`;
}

/** The absolute one-hour Timeline window centered on an alert at `firedAtMs`. */
export function windowAroundAlert(firedAtMs: number): AbsoluteWindow {
  return {
    absolute: {
      from_ms: firedAtMs - HALF_WINDOW_MS,
      to_ms: firedAtMs + HALF_WINDOW_MS,
    },
  };
}
