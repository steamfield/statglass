/**
 * The phone's chart window choices: the rolling durations every module page
 * and host card can show, and the one a fresh install starts with.
 */
import { RANGE_PRESETS } from "@core/chart-range";
import {
  CHART_WINDOW_MS,
  DEFAULT_CHART_WINDOW,
  RETENTION_DAYS,
} from "@core/generated/types";
import { DAY_MS } from "@core/time-grid";

// The phone does not receive per-host retention. Use the shortest setting.
const PHONE_RETENTION_MS = Math.min(...RETENTION_DAYS) * DAY_MS;

/** The preset windows the phone offers, shortest first. */
export const PHONE_RANGES = RANGE_PRESETS.filter(
  ({ ms }) => ms <= PHONE_RETENTION_MS
);

/** The window a fresh install shows, the Mac's default (`DEFAULT_CHART_WINDOW`). */
export const DEFAULT_CHART_WINDOW_MS = CHART_WINDOW_MS[DEFAULT_CHART_WINDOW];

/** Whether `ms` is one of the windows the phone offers. */
export function isPhoneRange(ms: unknown): ms is number {
  return PHONE_RANGES.some((range) => range.ms === ms);
}
