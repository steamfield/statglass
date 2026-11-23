/**
 * One member process under an open group, plus the cell pieces both row
 * kinds share: the config columns' cells and the hover actions cell.
 */
import type { ProcessTarget } from "@core/process-selection";
import type { ReactNode } from "react";
import { Link } from "react-router";
import {
  ProcessSelectionRow,
  SharedProcessActions,
} from "~/components/process-selection";
import { TableCell } from "~/components/ui/table";
import { cn } from "~/lib/utils";
import { memberLabel } from "./group-identity";
import type { GroupColumn, GroupRows } from "./types";

/** Body cell: 29 px rows, so the virtualizer's fixed estimate holds. */
export const CELL = "whitespace-nowrap px-3 py-0 font-normal";

/** Row chrome every body row shares. */
export const ROW =
  "group h-[29px] border-border-subtle border-b hover:bg-selected";

/** Column id of a PID column; with one, the name cell leaves the pid out. */
const PID_COLUMN = "pid";

/** Indent of a member's name: past the group's chevron and initial chip. */
const MEMBER_INDENT = "pl-[52px]";

/** The config columns' cells of one row, rendered by `cell`. */
export function ColumnCells<G, M>({
  columns,
  cell,
}: {
  columns: readonly GroupColumn<G, M>[];
  cell: (column: GroupColumn<G, M>) => ReactNode;
}) {
  return columns.map((column) => (
    <TableCell
      key={column.id}
      className={cn(
        CELL,
        column.align === "right" && "text-right",
        column.className
      )}
    >
      {cell(column)}
    </TableCell>
  ));
}

/**
 * Quit and Force Quit on hover or focus, acting on the row's targets. A row
 * with no targets and a `reason` shows the reason instead, always visible,
 * since it is what explains the disabled checkbox.
 */
export function ActionsCell({
  targets,
  reason,
}: {
  targets: readonly ProcessTarget[];
  reason: string | undefined;
}) {
  const unavailable = targets.length === 0 ? reason : undefined;
  return (
    <TableCell className="w-36 min-w-36 whitespace-nowrap py-0 pr-2 pl-1 text-right">
      {unavailable === undefined ? (
        <span className="inline-flex h-6 items-center align-middle opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 group-data-[state=open]:opacity-100">
          <SharedProcessActions targets={targets} />
        </span>
      ) : (
        <span className="pr-1 text-label text-muted-foreground">
          {unavailable}
        </span>
      )}
    </TableCell>
  );
}

/** A member's name, linked to its detail page when it has one. */
export function MemberName({
  name,
  href,
}: {
  name: string;
  href: string | undefined;
}) {
  if (href === undefined) return <span className="truncate">{name}</span>;
  return (
    <Link
      to={href}
      className="truncate rounded-chip outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      {name}
    </Link>
  );
}

/**
 * A member process: its name indented under the group with the pid beside
 * it (unless the table has a PID column), then its own figures. A member
 * with no targets (it has exited) gets a disabled checkbox and no actions,
 * or its `memberUnavailable` reason where the actions would be.
 */
export function MemberRow<G, M>({
  member,
  rows,
  columns,
  actions,
}: {
  member: M;
  rows: GroupRows<G, M>;
  columns: readonly GroupColumn<G, M>[];
  /** The table has an actions column. */
  actions: boolean;
}) {
  const name = rows.memberName(member);
  const pid = rows.memberPid(member);
  const targets = rows.memberTargets(member);
  const muted = rows.memberMuted?.(member) ?? false;
  const detail = rows.memberDetail?.(member);
  return (
    <ProcessSelectionRow
      rowKey={rows.memberKey(member)}
      label={memberLabel(rows, member)}
      targets={targets}
      disabledReason={rows.memberUnavailable?.(member)}
      data-name={name}
      data-pid={pid}
      className={cn(ROW, muted ? "text-muted-foreground" : "text-fg-subtle")}
    >
      <TableCell className={cn(CELL, MEMBER_INDENT)}>
        <span className="inline-flex min-w-0 max-w-64 items-baseline gap-2">
          <MemberName name={name} href={rows.memberHref?.(member)} />
          {!columns.some((c) => c.id === PID_COLUMN) && (
            <span
              className="figures text-label text-muted-foreground"
              title={detail}
            >
              {pid}
              {detail !== undefined && (
                <span className="sr-only">, {detail}</span>
              )}
            </span>
          )}
        </span>
      </TableCell>
      <ColumnCells columns={columns} cell={(c) => c.member(member)} />
      {actions && (
        <ActionsCell
          targets={targets}
          reason={rows.memberUnavailable?.(member)}
        />
      )}
    </ProcessSelectionRow>
  );
}
