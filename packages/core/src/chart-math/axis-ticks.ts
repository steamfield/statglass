import {
  formatBucketTime,
  formatClock,
  formatClockSeconds,
} from "@core/format";
import { hostTime } from "@core/host-clock";
import { ceilTo, DAY_MS, floorTo, HOUR_MS, MINUTE_MS } from "@core/time-grid";
import { CHART_CAPTION_CHAR_WIDTH_PX } from "@core/widget-models/chart-annotation";

export interface AxisTick {
  value: number;
  frac: number;
  label: string;
}

const DEFAULT_VALUE_TICKS = 3;
const MAX_VALUE_TICKS = 100;

/** Label a zero-based domain using the caller's fixed or already-snapped ceiling. */
export function valueTicks(
  ceiling: number,
  format: (value: number) => string,
  { count = DEFAULT_VALUE_TICKS }: { count?: number } = {}
): AxisTick[] {
  if (!Number.isFinite(ceiling) || ceiling <= 0) {
    return [{ value: 0, frac: 0, label: format(0) }];
  }
  const tickCount =
    Number.isFinite(count) && count <= MAX_VALUE_TICKS
      ? Math.max(2, Math.trunc(count))
      : DEFAULT_VALUE_TICKS;
  return Array.from({ length: tickCount }, (_, index) => {
    const frac = index / (tickCount - 1);
    const value = ceiling * frac;
    return { value, frac, label: format(value) };
  });
}

const SECOND_MS = 1000;
const MAX_DATE_MS = 8.64e15;
const LONGEST_GRID_STEP = 30 * DAY_MS;
const TIME_STEPS = [
  ...[1, 2, 5, 10, 15, 30].map((n) => n * SECOND_MS),
  ...[1, 2, 5, 10, 15, 30].map((n) => n * MINUTE_MS),
  ...[1, 2, 3, 4, 6, 8, 12].map((n) => n * HOUR_MS),
  ...[1, 2, 3, 7, 14].map((n) => n * DAY_MS),
  LONGEST_GRID_STEP,
];

function clockLabels(spanMs: number) {
  if (spanMs >= DAY_MS) {
    // "Nov 25, 13:05" is the widest label, allowing for a two-digit day.
    return {
      format: (ms: number) => formatBucketTime(ms, MINUTE_MS, true),
      maxChars: 13,
      resolutionMs: MINUTE_MS,
    };
  }
  return spanMs <= 5 * MINUTE_MS
    ? { format: formatClockSeconds, maxChars: 8, resolutionMs: SECOND_MS }
    : { format: formatClock, maxChars: 5, resolutionMs: MINUTE_MS };
}

function labelLeft(frac: number, width: number, plotWidth: number): number {
  if (frac === 0) return 0;
  if (frac === 1) return plotWidth - width;
  return frac * plotWidth - width / 2;
}

const localOffsetMs = (ms: number) =>
  -new Date(ms).getTimezoneOffset() * MINUTE_MS;

/** Snap to the wall clock used by the formatters, including offset changes. */
function ceilClockTick(ms: number, step: number): number {
  const offset = localOffsetMs(ms);
  const stamp = ceilTo(ms + offset, step) - offset;
  const nextOffset = localOffsetMs(stamp);
  if (offset === nextOffset) return stamp;

  // At a clock change, the new offset can put a valid grid tick before the
  // original candidate. If it still falls on the old offset, snap forward.
  const shifted = ceilTo(ms + nextOffset, step) - nextOffset;
  if (localOffsetMs(shifted) === nextOffset) return shifted;
  return ceilTo(stamp + nextOffset, step) - nextOffset;
}

function clockGrid(
  hostFrom: number,
  hostTo: number,
  {
    widthPx,
    availableWidth,
    labelWidth,
    resolutionMs,
  }: {
    widthPx: number;
    availableWidth: number;
    labelWidth: number;
    resolutionMs: number;
  }
) {
  const spanMs = hostTo - hostFrom;
  const minStep = Math.max(resolutionMs, (labelWidth * spanMs) / widthPx);
  const preferredStep =
    TIME_STEPS.find((ms) => ms >= minStep) ?? ceilTo(minStep, DAY_MS);
  const innerSpan = ((availableWidth - labelWidth) * spanMs) / widthPx;
  if (innerSpan < resolutionMs || preferredStep <= innerSpan) {
    return { start: hostFrom, end: hostTo, step: preferredStep };
  }

  // A coarse grid can miss the whole region where a centered label fits.
  // Use a finer grid within that region and still check each label for fit.
  let step =
    innerSpan >= LONGEST_GRID_STEP ? floorTo(innerSpan, DAY_MS) : resolutionMs;
  for (const candidate of TIME_STEPS) {
    if (candidate > innerSpan) break;
    step = Math.max(step, candidate);
  }
  const start = hostFrom + (labelWidth * spanMs) / (2 * widthPx);
  return { start, end: start + innerSpan, step };
}

/**
 * Bounds, now and returned values use the same caller clock. Apply the offset
 * for grid alignment and labels. Center interior labels and align edge labels
 * inward so the renderer can use the same boxes when laying out text.
 */
export function timeTicks(
  fromMs: number,
  toMs: number,
  widthPx: number,
  {
    clockOffsetMs,
    nowMs,
    captionScale = 1,
  }: { clockOffsetMs: number; nowMs: number; captionScale?: number }
): AxisTick[] {
  const spanMs = toMs - fromMs;
  const hostFrom = hostTime(fromMs, clockOffsetMs);
  const hostTo = hostTime(toMs, clockOffsetMs);
  const maxTime = Math.max(Math.abs(hostFrom), Math.abs(hostTo));
  if (
    !(spanMs > 0 && widthPx > 0 && maxTime <= MAX_DATE_MS) ||
    !Number.isFinite(widthPx)
  ) {
    return [];
  }

  const scale =
    Number.isFinite(captionScale) && captionScale > 0 ? captionScale : 1;
  const charWidth = CHART_CAPTION_CHAR_WIDTH_PX * scale;
  const { format, maxChars, resolutionMs } = clockLabels(spanMs);
  const nowLabel = "now";
  const nowWidth = nowLabel.length * charWidth;
  const showNow = toMs === nowMs && nowWidth <= widthPx;
  const availableWidth = showNow ? widthPx - nowWidth : widthPx;
  const { start, end, step } = clockGrid(hostFrom, hostTo, {
    widthPx,
    availableWidth,
    labelWidth: charWidth * maxChars,
    resolutionMs,
  });
  const roundingPx = widthPx * Number.EPSILON;
  const ticks: AxisTick[] = [];
  let previousRight = 0;
  for (
    let stamp = ceilClockTick(start, step);
    stamp <= end;
    stamp = ceilClockTick(stamp + 1, step)
  ) {
    if (showNow && stamp === hostTo) break;
    const value = stamp - clockOffsetMs;
    const frac = (value - fromMs) / spanMs;
    const label = format(stamp);
    const labelWidth = label.length * charWidth;
    const left = labelLeft(frac, labelWidth, widthPx);
    const right = left + labelWidth;
    if (
      left + roundingPx < previousRight ||
      right - roundingPx > availableWidth
    )
      continue;
    ticks.push({ value, frac, label });
    previousRight = right;
  }
  if (showNow) ticks.push({ value: toMs, frac: 1, label: nowLabel });
  return ticks;
}
