/**
 * Wall-clock and calendar labels in the viewer's time zone: "14:02",
 * "14:02:10", "Oct", "Sun", "Su".
 *
 * The tables are hand-built rather than `Intl.DateTimeFormat`, which follows
 * the WKWebView system locale and can give a 12-hour clock, "24:05" or a
 * translated month. StatGlass's labels are English and 24-hour everywhere.
 */
import { isPresent, type MaybeNumber, MISSING } from "./number";

export const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** Indexed by `Date.getDay()`, Sunday first. */
export const WEEKDAYS = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

/** Two-letter weekdays for the heatmap's row labels, Sunday first. */
export const WEEKDAYS_2 = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

/** "Oct" for the local month of `d`. */
export const monthName = (d: Date): string => MONTHS[d.getMonth()] as string;

/** "Sun" for the local weekday of `d`. */
export const weekdayName = (d: Date): string => WEEKDAYS[d.getDay()] as string;

/** Zero-padded to two digits: "05". */
export const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Local "HH:MM": "14:02". */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Local wall-clock time with seconds, "14:02:10": a brushed range's ends. */
export function formatClockSeconds(ms: MaybeNumber): string {
  if (!isPresent(ms)) return MISSING;
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * Local date and time with seconds, "Oct 5, 14:02:10": a moment that may not
 * be today (a last-seen time, a process start, an observation).
 */
export function formatDateTime(ms: MaybeNumber): string {
  if (!isPresent(ms)) return MISSING;
  const d = new Date(ms);
  return `${monthName(d)} ${d.getDate()}, ${formatClockSeconds(ms)}`;
}

/** Include a calendar date when a retained chart can span more than one day. */
export function formatHistoryTime(ms: number, dates: boolean): string {
  return dates ? formatDateTime(ms) : formatClockSeconds(ms);
}

/**
 * A history bucket's start in a chart's table: seconds only when buckets are
 * shorter than a minute (10 s rows would otherwise repeat "14:02"), and the
 * date when the table spans more than one local day.
 */
export function formatBucketTime(
  ms: number,
  bucketMs: number,
  dates: boolean
): string {
  const time = bucketMs < 60_000 ? formatClockSeconds(ms) : formatClock(ms);
  if (!dates) return time;
  const d = new Date(ms);
  return `${monthName(d)} ${d.getDate()}, ${time}`;
}
