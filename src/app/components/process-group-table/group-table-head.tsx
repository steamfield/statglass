/**
 * The grouped table's header row: the selection gutter, the name column,
 * the config columns as sort buttons, and the actions column.
 */
import type { ReactNode } from "react";
import type { ColumnSort } from "~/components/data-table";
import { ProcessSelectionHead } from "~/components/process-selection";
import { TableHead, TableRow } from "~/components/ui/table";
import { cn } from "~/lib/utils";
import type { ClientSort, GroupColumn, ProcessGroupTableProps } from "./types";
import { NAME_COLUMN } from "./use-group-order";

/** A column's header sorts when it says so, else when it has a sort value. */
function columnSortable<G, M>(column: GroupColumn<G, M>): boolean {
  return (
    column.sortable ??
    (column.groupValue !== undefined || column.memberValue !== undefined)
  );
}

const HEADER = "h-auto whitespace-nowrap border-border border-b";

/**
 * One column header; a button that sorts by it when the column is sortable.
 * The column the rows are ranked by shows its direction either way, so a
 * Rust-ranked table names its order without a button that does nothing.
 */
function HeadCell({
  id,
  align,
  current,
  sort,
  className,
  children,
}: {
  id: string;
  align: "left" | "right";
  /** The order the rows are in, sortable or not. */
  current: ColumnSort<string> | undefined;
  /** Absent: the column does not sort. */
  sort: ClientSort | undefined;
  className: string | undefined;
  children: ReactNode;
}) {
  const dir = current?.by === id ? current.dir : null;
  const arrow = dir && <span aria-hidden>{dir === "desc" ? " ↓" : " ↑"}</span>;
  const right = align === "right";
  const next = (): ColumnSort<string> => {
    if (dir) return { by: id, dir: dir === "desc" ? "asc" : "desc" };
    // Figures start high to low, names A to Z.
    return { by: id, dir: right ? "desc" : "asc" };
  };
  return (
    <TableHead
      scope="col"
      aria-sort={
        dir === null ? undefined : dir === "asc" ? "ascending" : "descending"
      }
      className={cn(HEADER, right && "text-right", sort && "p-0", className)}
    >
      {sort ? (
        <button
          type="button"
          onClick={() => sort.onChange(next())}
          className={cn(
            "w-full px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring",
            right ? "text-right" : "text-left",
            dir
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {children}
          {arrow}
        </button>
      ) : (
        <>
          {children}
          {arrow}
        </>
      )}
    </TableHead>
  );
}

/** The header row: selection gutter, name, config columns, actions. */
export function GroupTableHead<G, M>({
  table,
  sticky,
}: {
  table: ProcessGroupTableProps<G, M>;
  sticky: boolean;
}) {
  const { sort, columns, selectable } = table;
  return (
    <thead className={sticky ? "sticky top-0 z-10 bg-card" : undefined}>
      <TableRow className="border-0 transition-none hover:bg-transparent">
        {selectable && <ProcessSelectionHead />}
        <HeadCell
          id={NAME_COLUMN}
          align="left"
          current={sort?.value}
          sort={(sort?.nameSortable ?? true) ? sort : undefined}
          className={undefined}
        >
          {table.nameHeader}
        </HeadCell>
        {columns.map((c) => (
          <HeadCell
            key={c.id}
            id={c.id}
            align={c.align}
            current={sort?.value}
            sort={columnSortable(c) ? sort : undefined}
            className={c.className}
          >
            {c.header}
          </HeadCell>
        ))}
        {selectable && (
          <th
            scope="col"
            className="w-36 border-border border-b p-0 font-normal"
          >
            <span className="sr-only">Actions</span>
          </th>
        )}
      </TableRow>
    </thead>
  );
}
