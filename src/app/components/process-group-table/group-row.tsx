/**
 * One app group row: chevron, initial chip, name and muted process count in
 * the name cell, then the group's figures and its actions. ArrowRight opens
 * the group and ArrowLeft closes it.
 */
import { processCount } from "@core/usage-rows";
import { ChevronRight } from "lucide-react";
import type { KeyboardEvent } from "react";
import { ProcessSelectionRow } from "~/components/process-selection";
import { TableCell } from "~/components/ui/table";
import { cn } from "~/lib/utils";
import { InitialChip } from "~/widgets/initial-chip";
import { ActionsCell, CELL, ColumnCells, ROW } from "./member-row";
import type { GroupColumn, GroupRows } from "./types";

/** The chevron that opens and closes a group of several processes. */
function Chevron({
  name,
  open,
  onToggle,
}: {
  name: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        // Opening a group is not choosing it: keep the click from the row's selection.
        event.stopPropagation();
        onToggle();
      }}
      aria-expanded={open}
      aria-label={`${open ? "Hide" : "Show"} ${name} processes`}
      className="-ml-1 grid size-4 place-items-center rounded-chip text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ChevronRight
        aria-hidden
        className={cn(
          "size-3.5 transition-transform duration-(--motion-fast)",
          open && "rotate-90"
        )}
      />
    </button>
  );
}

/** A group row; `expandable` groups (more than one process) get the chevron and count. */
export function GroupRow<G, M>({
  group,
  rows,
  columns,
  actions,
  expandable,
  open,
  onToggle,
}: {
  group: G;
  rows: GroupRows<G, M>;
  columns: readonly GroupColumn<G, M>[];
  /** The table has an actions column. */
  actions: boolean;
  expandable: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const name = rows.name(group);
  const targets = rows.targets(group);
  const onKeyDown = (event: KeyboardEvent<HTMLTableRowElement>) => {
    if (!expandable) return;
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    if ((event.key === "ArrowRight") !== open) onToggle();
  };
  return (
    <ProcessSelectionRow
      rowKey={rows.key(group)}
      label={name}
      targets={targets}
      data-name={name}
      className={cn(ROW, "text-fg-subtle")}
      onKeyDown={onKeyDown}
    >
      <TableCell className={CELL}>
        <span className="inline-flex min-w-0 max-w-80 items-center gap-2 align-middle text-foreground">
          {expandable ? (
            <Chevron name={name} open={open} onToggle={onToggle} />
          ) : (
            <span aria-hidden className="-ml-1 inline-block size-4" />
          )}
          <InitialChip text={name} />
          <span className="truncate">{name}</span>
          {expandable && (
            <span className="font-normal text-label text-muted-foreground">
              {processCount(rows.count(group))}
            </span>
          )}
        </span>
      </TableCell>
      <ColumnCells columns={columns} cell={(c) => c.group(group)} />
      {actions && <ActionsCell targets={targets} />}
    </ProcessSelectionRow>
  );
}
