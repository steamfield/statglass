import { formatBucketTime } from "@core/format";
import type { Row } from "@tanstack/react-table";
import { useMemo } from "react";
import { Table, TableCell, TableHeader, TableRow } from "~/components/ui/table";
import { cn } from "~/lib/utils";
import { DataTable } from "./data-table";
import { DataTableCells } from "./data-table-cells";
import { DataTableHead } from "./data-table-head";
import { columnHelper, gap, type TableFeatures } from "./features";
import { useDataTable } from "./use-data-table";

/** One plotted series: its column group's name and how its values read. */
export interface ChartTableSeries {
  id: string;
  label: string;
  format: (value: number | null) => string;
}

/** A series' bucket; `partial` when the bucket was only partly measured. */
export interface ChartTableStats {
  min: number | null;
  avg: number | null;
  max: number | null;
  partial?: boolean;
}

/**
 * A bucket, with one entry per series (`null`: that series has no reading in
 * it), or a gap: a span nothing was recorded in, named by its label.
 */
export type ChartTableRow =
  | { kind: "bucket"; t: number; values: readonly (ChartTableStats | null)[] }
  | { kind: "gap"; t: number; label: string };

export interface ChartTableProps {
  /** The table's accessible name. */
  label: string;
  series: readonly ChartTableSeries[];
  rows: readonly ChartTableRow[];
  bucketMs: number;
  fromMs: number;
  toMs: number;
  /** The surface the sticky header sits on. */
  surface: "card" | "popover";
  className?: string;
}

const STATS = ["min", "avg", "max"] as const;
const STAT_LABEL = { min: "Min", avg: "Avg", max: "Max" } as const;
const helper = columnHelper<ChartTableRow>();
/** Two gaps clipped to the same range start differ by label. */
const rowId = (row: ChartTableRow) =>
  row.kind === "gap" ? `gap-${row.t}-${row.label}` : `bucket-${row.t}`;
/**
 * The Time column stays in view while value columns scroll under it, on the
 * surface's fill so scrolled cells don't show through.
 */
const STICKY = {
  card: "sticky left-0 z-[1] bg-card",
  popover: "sticky left-0 z-[1] bg-popover",
} as const;
/** A body cell's fill hides the row's hover tint, so it layers the tint on. */
const ROW_HOVER =
  "[tr:hover>&]:bg-[image:linear-gradient(var(--color-selected),var(--color-selected))]";
const byTime = (a: ChartTableRow, b: ChartTableRow) =>
  a.t - b.t || (a.kind === b.kind ? 0 : a.kind === "gap" ? -1 : 1);
const sameDay = (a: number, b: number) =>
  new Date(a).toDateString() === new Date(b).toDateString();

/** Divides one series' min/avg/max from the next when several share a table. */
const GROUP_EDGE = "border-l border-border-subtle";

function statColumns(series: ChartTableSeries, i: number, grouped: boolean) {
  return STATS.map((stat) =>
    helper.accessor(
      (row) =>
        row.kind === "bucket" ? gap(row.values[i]?.[stat] ?? null) : undefined,
      {
        id: `${series.id}:${stat}`,
        header: STAT_LABEL[stat],
        meta:
          grouped && stat === STATS[0]
            ? {
                align: "right",
                className: GROUP_EDGE,
                cellClassName: GROUP_EDGE,
              }
            : { align: "right" },
        cell: ({ row: { original: row } }) => {
          if (row.kind !== "bucket") return null;
          const value = row.values[i];
          return (
            <>
              {series.format(value?.[stat] ?? null)}
              {stat === "max" && value?.partial && (
                <span className="text-muted-foreground"> partial</span>
              )}
            </>
          );
        },
      }
    )
  );
}

function chartColumns(
  series: readonly ChartTableSeries[],
  clock: (t: number) => string,
  sticky: string
) {
  const time = helper.accessor((row) => row.t, {
    id: "time",
    header: "Time",
    meta: {
      align: "left",
      className: sticky,
      cellClassName: cn(sticky, ROW_HOVER),
    },
    cell: ({ getValue }) => clock(getValue()),
  });
  if (series.length === 1 && series[0])
    return helper.columns([time, ...statColumns(series[0], 0, false)]);
  return helper.columns([
    time,
    ...series.map((s, i) =>
      helper.group({
        id: s.id,
        header: s.label,
        meta: { align: "right", className: cn("text-center", GROUP_EDGE) },
        columns: helper.columns(statColumns(s, i, true)),
      })
    ),
  ]);
}

/**
 * "Show as table" for a chart (design-system.md Accessibility): one row per
 * bucket in the visible range, oldest first, with min, avg and max for each
 * plotted series, and a row naming each gap where the chart breaks. Every
 * column sorts; gap rows sort last by value.
 */
export function ChartTable({
  label,
  series,
  rows,
  bucketMs,
  fromMs,
  toMs,
  surface,
  className,
}: ChartTableProps) {
  const dates = !sameDay(fromMs, Math.max(fromMs, toMs - 1));
  const sticky = STICKY[surface];
  const columns = useMemo(
    () =>
      chartColumns(series, (t) => formatBucketTime(t, bucketMs, dates), sticky),
    [series, bucketMs, dates, sticky]
  );
  const { table, rows: sorted } = useDataTable({
    data: rows,
    columns,
    getRowId: rowId,
    tiebreak: byTime,
    initialSorting: [{ id: "time", desc: false }],
  });
  const valueColumns = series.length * STATS.length;
  const renderRow = (row: Row<TableFeatures, ChartTableRow>) =>
    row.original.kind === "gap" ? (
      <TableRow className="text-[12px]">
        <TableCell
          className={cn("figures whitespace-nowrap", sticky, ROW_HOVER)}
        >
          {formatBucketTime(row.original.t, bucketMs, dates)}
        </TableCell>
        <TableCell
          colSpan={valueColumns}
          className="text-right text-muted-foreground"
        >
          {row.original.label}
        </TableCell>
      </TableRow>
    ) : (
      <TableRow className="text-[12px]">
        <DataTableCells row={row} className="figures whitespace-nowrap" />
      </TableRow>
    );
  return (
    <section
      aria-label={label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard scrolling needs a focusable table viewport
      tabIndex={0}
      className={cn(
        "overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
    >
      <Table aria-label={label}>
        <TableHeader
          className={cn(
            "sticky top-0 z-10",
            surface === "card" ? "bg-card" : "bg-popover"
          )}
        >
          <DataTableHead table={table} />
        </TableHeader>
        <DataTable table={table} rows={sorted} renderRow={renderRow} />
      </Table>
    </section>
  );
}
