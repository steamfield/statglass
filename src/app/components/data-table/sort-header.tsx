import { FlexRender, type Header, type RowData } from "@tanstack/react-table";
import { TableHead } from "~/components/ui/table";
import { cn } from "~/lib/utils";
import type { TableFeatures } from "./features";

export function SortHeader<T extends RowData>({
  header,
}: {
  header: Header<TableFeatures, T>;
}) {
  // A placeholder holds a leaf column's place in a grouped header's upper row.
  if (header.isPlaceholder) return <TableHead aria-hidden />;
  const { column } = header;
  const meta = column.columnDef.meta;
  const right = meta?.align !== "left";
  const ranked = meta?.ranked;
  const sortable = ranked ? false : column.getCanSort();
  const dir = ranked ? "desc" : column.getIsSorted();
  const label = <FlexRender header={header} />;
  const arrow = <SortArrow dir={dir} />;
  return (
    <TableHead
      scope={header.subHeaders.length > 0 ? "colgroup" : "col"}
      colSpan={header.colSpan}
      aria-sort={!dir ? undefined : dir === "asc" ? "ascending" : "descending"}
      className={cn(
        right && "text-right",
        ranked ? "text-foreground" : sortable && "p-0",
        meta?.className
      )}
    >
      {sortable ? (
        <button
          type="button"
          onClick={column.getToggleSortingHandler()}
          className={cn(
            "w-full px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring",
            right ? "text-right" : "text-left",
            dir
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {label}
          {arrow}
        </button>
      ) : (
        <>
          {label}
          {arrow}
        </>
      )}
    </TableHead>
  );
}

function SortArrow({ dir }: { dir: false | "asc" | "desc" }) {
  if (!dir) return null;
  return <span aria-hidden>{dir === "desc" ? " ↓" : " ↑"}</span>;
}
