/**
 * One app group row: chevron, initial chip, name and muted process count in
 * the name cell, then the group's figures and its actions (or why it has
 * none). ArrowRight opens the group and ArrowLeft closes it.
 */
import { processCount } from "@core/usage-rows";
import { ChevronRight } from "lucide-react";
import type { KeyboardEvent } from "react";
import { ProcessSelectionRow } from "~/components/process-selection";
import { TableCell } from "~/components/ui/table";
import { cn } from "~/lib/utils";
import { InitialChip } from "~/widgets/initial-chip";
import { groupLabel, soleMember } from "./group-identity";
import { ActionsCell, CELL, ColumnCells, MemberName, ROW } from "./member-row";
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

/** Muted text beside a group's name: its process count or its sole process. */
function Aside({ children }: { children: string }) {
  return (
    <span className="truncate font-normal text-label text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * The group's name, then its process count when there are several. A group
 * of one reads as its process: the name links to the process's detail page,
 * and the process's own name shows beside the app's when they differ.
 */
function GroupName<G, M>({ group, rows }: { group: G; rows: GroupRows<G, M> }) {
  const name = rows.name(group);
  const count = rows.count(group);
  const sole = soleMember(rows, group);
  if (sole === undefined) {
    return (
      <>
        <span className="truncate">{name}</span>
        {count !== null && count > 1 && <Aside>{processCount(count)}</Aside>}
      </>
    );
  }
  const soleName = rows.memberName(sole);
  return (
    <>
      <MemberName name={name} href={rows.memberHref?.(sole)} />
      {soleName !== name && <Aside>{soleName}</Aside>}
    </>
  );
}

/**
 * A group row. Groups of several processes show their count; `expandable`
 * ones (not held open by a search) also get the chevron.
 */
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
      label={groupLabel(rows, group)}
      targets={targets}
      disabledReason={rows.unavailable?.(group)}
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
          <GroupName group={group} rows={rows} />
        </span>
      </TableCell>
      <ColumnCells columns={columns} cell={(c) => c.group(group)} />
      {actions && (
        <ActionsCell targets={targets} reason={rows.unavailable?.(group)} />
      )}
    </ProcessSelectionRow>
  );
}
