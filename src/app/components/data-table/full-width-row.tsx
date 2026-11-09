import type { ReactNode } from "react";
import { TableCell, TableRow } from "~/components/ui/table";
import { cn } from "~/lib/utils";

/**
 * One cell across the table, for a body's empty, loading and note rows.
 * `empty` sits at row height; `footnote` is smaller and wraps. Neither
 * highlights on hover.
 */
export function FullWidthRow({
  colSpan,
  tone = "empty",
  className,
  children,
}: {
  colSpan: number;
  tone?: "empty" | "footnote";
  /** Layout only, such as an indent that lines up with the rows above. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <TableRow className="border-0 transition-none hover:bg-transparent">
      <TableCell
        colSpan={colSpan}
        className={cn(
          "px-3 font-normal text-muted-foreground",
          tone === "empty"
            ? "h-[29px] py-0 text-small"
            : "whitespace-normal pt-1 pb-2.5 text-label leading-[1.45]",
          className
        )}
      >
        {children}
      </TableCell>
    </TableRow>
  );
}
