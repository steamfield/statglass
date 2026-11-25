import { niceCeiling } from "@core/chart-math/nice-ceiling";
import { formatPercent, formatRate } from "@core/format";
import type { historyGrid } from "@core/history-grid";
import { MINUTE_MS } from "@core/time-grid";
import { type GapSpan, gapBandsModel } from "@core/widget-models/gap-band";
import type { MirrorBarsData } from "@core/widget-models/mirror-bars";
import type { StreamAreaData } from "@core/widget-models/stream-area";

export const SPARKLINE_MS = 30 * MINUTE_MS;
export const SUMMARY_MS = 5_000;

export type Summary = {
  ts: number;
  timeline: number;
  intervalMs: number;
  values: (number | null)[];
};

export function appendSummary(previous: readonly Summary[], next: Summary) {
  const { ts, timeline } = next;
  const retained =
    previous.at(-1)?.timeline === timeline
      ? previous.filter(
          (point) => point.ts < ts && point.ts > ts - SPARKLINE_MS
        )
      : [];
  return [...retained, next];
}

export function sparkWindow(
  history: ReturnType<typeof historyGrid> | null,
  historyEnd: number,
  summaries: readonly Summary[],
  keys: readonly string[]
) {
  const latest = summaries.at(-1);
  if (!latest) {
    return {
      values: keys.map((key) => history?.values[key] ?? []),
      tEndMs: history?.endMs ?? 0,
      intervalMs: history?.bucketMs ?? SUMMARY_MS,
    };
  }
  const { intervalMs } = latest;
  const count = Math.floor(SPARKLINE_MS / intervalMs) + 1;
  const start = latest.ts - (count - 1) * intervalMs;
  const values = keys.map((key) => {
    const buckets = history?.values[key];
    if (!history || !buckets) return Array<number | null>(count).fill(null);
    const historyStart =
      history.endMs - (buckets.length - 1) * history.bucketMs;
    return Array.from({ length: count }, (_, i) => {
      // Plot the host's bucket average across the span the bucket covers.
      const ts = start + i * intervalMs;
      if (ts > historyEnd) return null;
      const covered = Math.min(ts, history.endMs);
      const bucket = Math.floor((covered - historyStart) / history.bucketMs);
      return buckets[bucket] ?? null;
    });
  });
  // Keep distinct samples when host timestamps round to the same grid slot.
  let next = count;
  for (let index = summaries.length - 1; index >= 0; index--) {
    const sample = summaries[index];
    if (!sample) continue;
    const i = Math.min(next - 1, Math.round((sample.ts - start) / intervalMs));
    if (i < 0) break;
    values.forEach((series, metric) => {
      series[i] = sample.values[metric] ?? null;
    });
    next = i;
  }
  return { values, tEndMs: latest.ts, intervalMs };
}

function peak(values: readonly (number | null)[]) {
  return values.reduce<number | null>(
    (max, value) => (value === null ? max : Math.max(max ?? value, value)),
    null
  );
}

function gapDescription(...series: (readonly (number | null)[])[]) {
  return series.some((values) => values.includes(null))
    ? ", gaps in history"
    : "";
}

const historyLabel = (name: string) =>
  `${name} history over the last 30 minutes`;

export function percentSparkline(
  accent: "cpu" | "mem",
  values: (number | null)[],
  maxima: readonly (number | null)[],
  timing: Pick<StreamAreaData, "intervalMs" | "tEndMs">,
  gaps: readonly GapSpan[]
): StreamAreaData | null {
  const max = peak(maxima);
  if (max === null) return null;
  const floor = accent === "cpu" ? 10 : 25;
  // The 30% rung keeps the short plot useful between 20% and 40%.
  const yMax =
    max > floor && max > 20 && max <= 30 ? 30 : niceCeiling(max, floor);
  return {
    ...timing,
    accent,
    height: 36,
    yMax,
    gaps,
    ceilingLabel: formatPercent(yMax),
    series: [
      { key: accent === "cpu" ? "cpu.total" : "mem.used", values, step: 1 },
    ],
    ariaLabel: `${historyLabel(accent === "cpu" ? "CPU" : "Memory")}, peak ${formatPercent(max)}${gapDescription(values)}`,
  };
}

export function networkSparkbars(
  down: (number | null)[],
  up: (number | null)[],
  downMax: readonly (number | null)[],
  upMax: readonly (number | null)[],
  timing: Pick<MirrorBarsData, "intervalMs" | "tEndMs">,
  budget: number,
  gaps: readonly GapSpan[]
) {
  const downPeak = peak(downMax);
  const upPeak = peak(upMax);
  if (downPeak === null && upPeak === null) return null;
  const stride = Math.max(1, Math.ceil(down.length / budget));
  const bars = (values: (number | null)[]) => {
    const groups = [];
    // Anchor the groups at now so the rightmost summary remains visible.
    for (let end = values.length; end > 0; end -= stride) {
      const group = values.slice(Math.max(0, end - stride), end);
      // A bar shows the highest measured bucket in its span. A span
      // without any samples remains empty.
      groups.push(peak(group));
    }
    return groups.reverse();
  };
  const end = timing.tEndMs ?? 0;
  return {
    ...timing,
    intervalMs: timing.intervalMs * stride,
    accent: "net",
    up: bars(up),
    down: bars(down),
    upMax: niceCeiling(upPeak ?? 0),
    downMax: niceCeiling(downPeak ?? 0),
    bands: gapBandsModel(gaps, end - SPARKLINE_MS, end),
    ariaLabel: `${historyLabel("Network")}, download peak ${formatRate(downPeak)}, upload peak ${formatRate(upPeak)}${gapDescription(down, up)}`,
  } satisfies MirrorBarsData & { bands: ReturnType<typeof gapBandsModel> };
}
