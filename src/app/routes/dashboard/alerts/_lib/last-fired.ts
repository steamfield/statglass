/**
 * The text of a rule's last-fired line on the Alerts page: how long ago the
 * rule last fired. Pure; no React.
 */
import { DAY_MS, HOUR_MS, MINUTE_MS } from "@core/time-grid";

/**
 * "Last fired just now" under a minute ago, then whole minutes, hours and
 * days rounded down: "Last fired 5 min ago", "1 h ago", "3 d ago". A time
 * ahead of `nowMs` (clock skew) reads as just now.
 */
export function lastFiredText(firedAtMs: number, nowMs: number): string {
  const agoMs = nowMs - firedAtMs;
  if (agoMs < MINUTE_MS) return "Last fired just now";
  if (agoMs < HOUR_MS) {
    return `Last fired ${Math.floor(agoMs / MINUTE_MS)} min ago`;
  }
  if (agoMs < DAY_MS) return `Last fired ${Math.floor(agoMs / HOUR_MS)} h ago`;
  return `Last fired ${Math.floor(agoMs / DAY_MS)} d ago`;
}
