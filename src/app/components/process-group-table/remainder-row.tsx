/**
 * Rows after the groups that are not processes: a remainder ("Other apps",
 * "Protocol overhead", "System and other") with figures in the table's
 * columns, and a note under one that lines up with the app names. Pages
 * render them from `after`, which hands them the table's shape.
 */
import type { ReactNode } from "react";
import { OtherChip } from "~/components/app-table";
import { FullWidthRow } from "~/components/data-table";
import { TableCell, TableRow } from "~/components/ui/table";
import { cn } from "~/lib/utils";
import { CELL, ColumnCells } from "./member-row";
import type { AfterRows, GroupColumn } from "./types";

/**
 * A remainder row, as tall as the group rows and with its cells under
 * theirs: an empty checkbox gutter and actions cell when the table has
 * them, since there is nothing to select or quit; the chevron's and the
 * chip's places in the name cell, the system row marking the chip's place
 * with a dashed square. Muted, with a rule above the first remainder row.
 */
export function RemainderRow<G, M>({
  table,
  columns,
  name,
  system,
  first,
  cell,
}: {
  table: AfterRows;
  columns: readonly GroupColumn<G, M>[];
  name: string;
  /** "System and other": the dashed square, and no rule under it. */
  system: boolean;
  /** The first remainder row: a rule above it. */
  first: boolean;
  /** The row's content in `column`; cells take the column's alignment and classes. */
  cell: (column: GroupColumn<G, M>) => ReactNode;
}) {
  return (
    <TableRow
      className={cn(
        "h-[29px] border-border-subtle border-b text-muted-foreground transition-none hover:bg-transparent",
        first && "border-border border-t",
        system && "border-b-0"
      )}
    >
      {table.selectable && <TableCell aria-label="Selection" />}
      <TableCell className={CELL}>
        <span className="inline-flex items-center gap-2 align-middle">
          <span aria-hidden className="-ml-1 inline-block size-4" />
          {system ? (
            <OtherChip />
          ) : (
            <span aria-hidden className="inline-block w-4 flex-none" />
          )}
          {name}
        </span>
      </TableCell>
      <ColumnCells columns={columns} cell={cell} />
      {table.selectable && <TableCell />}
    </TableRow>
  );
}

/**
 * A note under a remainder row, saying what it holds. It starts where the
 * names do: past the checkbox gutter, the chevron's place and the chip.
 */
export function RemainderNote({
  table,
  children,
}: {
  table: AfterRows;
  children: ReactNode;
}) {
  return (
    <FullWidthRow
      colSpan={table.colSpan}
      tone="footnote"
      className={cn("pt-0", table.selectable ? "pl-22" : "pl-14")}
    >
      {children}
    </FullWidthRow>
  );
}
