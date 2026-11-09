import { formatPercent } from "@core/format";
import type { ProcessesAt } from "@core/generated/bindings";
import { topBy } from "@core/top-by";
import type { CSSProperties } from "react";
import {
  ChartTooltipHead,
  ChartTooltipNote,
  ChartTooltipRow,
  ChartTooltipRows,
  ChartTooltipShell,
} from "~/components/charts/chart-tooltip";
import { useIsLocalHost } from "~/hooks/use-is-local-host";
import { InitialChip } from "~/widgets/initial-chip";
import type { Accent } from "~/widgets/lib/accent";
import { FIELD_LABEL } from "~/widgets/lib/classes";

export interface TooltipRow {
  label: string;
  value: string;
  accent: Accent;
}

export interface CrosshairTooltipProps {
  /** "Sun Oct 4 · 14:02:00". */
  title: string;
  /** `resolutionLabel` of the drawn buckets: "1 min avg". */
  resolution: string;
  rows: TooltipRow[];
  /** `undefined` while the query is in flight; `null` when nothing was stored then. */
  processes: ProcessesAt | null | undefined;
  /** A note in place of the rows, inside a gap ("Asleep 5h 15m · no samples"). */
  note?: string | undefined;
  style: CSSProperties;
}

const TOP = 5;

/** The tooltip's width, px: `tooltipBeside` places and sizes it. */
export const CROSSHAIR_TOOLTIP_WIDTH = 276;

/**
 * The single crosshair tooltip: the moment and its resolution,
 * one row per lane with the bucket average, then the top processes stored
 * nearest that moment in % of one core.
 */
export function CrosshairTooltip({
  title,
  resolution,
  rows,
  processes,
  note,
  style,
}: CrosshairTooltipProps) {
  const local = useIsLocalHost();
  const top = topBy(processes?.rows ?? [], (p) => p.cpu_pct, TOP);
  // Stored rows whose CPU is null are not "nothing stored".
  const empty =
    processes === undefined
      ? "Looking up processes…"
      : !processes?.rows.length
        ? "No processes stored near this time"
        : top.length === 0
          ? "No CPU readings for processes then"
          : null;
  return (
    <ChartTooltipShell className="top-0.5" style={style}>
      <ChartTooltipHead title={title} detail={resolution} />
      {note ? (
        <ChartTooltipNote>{note}</ChartTooltipNote>
      ) : (
        <ChartTooltipRows>
          {rows.map((r) => (
            <ChartTooltipRow
              key={r.label}
              color={`var(--color-${r.accent})`}
              label={r.label}
              value={r.value}
            />
          ))}
        </ChartTooltipRows>
      )}
      {!note && local && (
        <>
          <div className="h-px bg-border" />
          <div className="flex justify-between">
            <span className={FIELD_LABEL}>Top processes then</span>
            <span className={FIELD_LABEL}>% of 1 core</span>
          </div>
          {empty ? (
            <ChartTooltipNote>{empty}</ChartTooltipNote>
          ) : (
            <div className="flex flex-col gap-[5px]">
              {top.map(({ row: p, value: cpu }) => (
                <div
                  key={`${p.pid}:${p.name}`}
                  className="flex items-center gap-2 text-small"
                >
                  <InitialChip text={p.name} />
                  <span className="flex-1 truncate font-normal text-fg-subtle">
                    {p.name}
                  </span>
                  <span className="figures">{formatPercent(cpu)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </ChartTooltipShell>
  );
}
