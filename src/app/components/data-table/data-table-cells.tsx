import { FlexRender, type Row, type RowData } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { TableCell } from "~/components/ui/table";
import { cn } from "~/lib/utils";
import { MeterTrack } from "~/widgets/meter-track";
import type { TableFeatures } from "./features";

export function DataTableCells<T extends RowData>({
  row,
  className,
}: {
  row: Row<TableFeatures, T>;
  className?: string;
}) {
  return row.getAllCells().map((cell) => (
    <TableCell
      key={cell.id}
      className={cn(
        className,
        cell.column.columnDef.meta?.align === "right" && "text-right",
        cell.column.columnDef.meta?.cellClassName
      )}
    >
      <FlexRender cell={cell} />
    </TableCell>
  ));
}

/** Figure slot widths: a percent ("100.0%"), or a used / limit pair. */
const FIGURE = { percent: "w-11", ratio: "min-w-30" } as const;

/**
 * A bar-plus-figure cell body: a 48 px track, then the figure right-aligned
 * in a fixed slot, so bars and figures line up down a column at 1 Hz.
 */
export function MeterCell({
  fraction,
  fill,
  figure = "percent",
  className,
  children,
}: {
  /** Fill of the track; `null` is a missing reading (an empty track). */
  fraction: number | null;
  /** CSS background of the fill: a module color or the accent in scope. */
  fill: string;
  figure?: keyof typeof FIGURE;
  /** Color of the figure only; it inherits the row's by default. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-2 align-middle">
      <MeterTrack
        fraction={fraction}
        fill={fill}
        className="inline-block w-12"
      />
      <span
        className={cn(
          "figures inline-block whitespace-nowrap text-right",
          FIGURE[figure],
          className
        )}
      >
        {children}
      </span>
    </span>
  );
}
