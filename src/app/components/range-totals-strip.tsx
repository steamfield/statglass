import { formatSpan, MISSING } from "@core/format";
import type { MetricStat } from "@core/generated/types";
import { measuredShort } from "@core/range-totals";
import { useMemo } from "react";
import { heldFor, useRangeScope } from "~/hooks/use-range-scope";
import { useSeriesStats } from "~/hooks/use-series-stats";
import { StatList } from "~/widgets/stat-list";

export interface RangeTotal {
  /** An unlabelled catalog metric (`cpu.total`). */
  metric: string;
  /** "Avg", "Peak", "↓ Read": the strip appends the span. */
  label: string;
  /** The figure; `stat` is undefined until the answer arrives. */
  format: (stat: MetricStat) => string;
}

/**
 * Figures over the chart window (D-091), or over the brushed range when
 * there is one (D-099), beside a page's live stat strip. The window ends
 * where the open 10 s bucket starts, so the figures change every 10 s.
 */
export function RangeTotalsStrip({
  windowMs,
  totals,
  testId,
}: {
  windowMs: number;
  totals: readonly RangeTotal[];
  testId?: string;
}) {
  const { selection, range, keepPrevious } = useRangeScope(windowMs);
  const metrics = useMemo(
    () => [...new Set(totals.map((t) => t.metric))],
    [totals]
  );
  const q = useSeriesStats(metrics, range, { keepPrevious });
  const shown = heldFor(q, windowMs);
  const scope = formatSpan(
    selection ? selection.toMs - selection.fromMs : windowMs
  );
  return (
    <div data-testid={testId}>
      <StatList
        items={totals.map((t) => {
          const stat = shown?.metrics.find((m) => m.metric === t.metric);
          const short =
            stat && shown
              ? measuredShort(stat, shown.to_ms - shown.from_ms)
              : null;
          return {
            label: `${t.label} · ${scope}`,
            value: stat ? t.format(stat) : MISSING,
            unit: short === null ? undefined : `in ${short}`,
          };
        })}
      />
    </div>
  );
}
