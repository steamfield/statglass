/**
 * The one table every process and per-app view renders: app groups that
 * expand to their processes, shared selection, Quit and Force Quit, client or
 * Rust-ranked order, row hold, and virtualization for the full process list.
 * This file wires those together: expansion, the Show all limit and the
 * selection surface. The header is `group-table-head`, the bodies
 * `group-table-body`, rows `group-row` and `member-row`, order
 * `use-group-order`.
 */
import { type ReactNode, useState } from "react";
import type { ColumnSort } from "~/components/data-table";
import {
  ProcessSelectionSurface,
  SELECTION_BAR_PX,
} from "~/components/process-selection";
import { TableCell, TableRow } from "~/components/ui/table";
import { GroupRow } from "./group-row";
import {
  type BodyProps,
  HEAD_PX,
  PlainTable,
  VirtualTable,
} from "./group-table-body";
import { MemberRow } from "./member-row";
import {
  selectionRows,
  useStableTargets,
  visibleTargets,
} from "./selection-rows";
import type { ProcessGroupTableProps } from "./types";
import { useGroupOrder, type VisibleRow } from "./use-group-order";

type Props<G, M> = ProcessGroupTableProps<G, M>;

/** Group keys the reader opened: the page's when it owns them, else the table's own. */
function useExpansion(expansion: Props<unknown, unknown>["expansion"]) {
  const [own, setOwn] = useState<ReadonlySet<string>>(() => new Set());
  const open = expansion?.open ?? own;
  const toggle = (key: string) => {
    const next = new Set(open);
    if (!next.delete(key)) next.add(key);
    if (expansion) expansion.onChange(next);
    else setOwn(next);
  };
  return { open, toggle };
}

/** Renders `rows` as app groups and member processes; see `ProcessGroupTableProps`. */
export function ProcessGroupTable<G, M>(props: Props<G, M>): ReactNode {
  if (props.selectable === null) return null;
  return <GroupTable {...props} selectable={props.selectable} />;
}

/** The table once it is known whether it offers selection. */
function GroupTable<G, M>(props: Props<G, M> & { selectable: boolean }) {
  const { open, toggle } = useExpansion(props.expansion);
  const [showAll, setShowAll] = useState(false);
  // The selection surface holds for a selection, a pending quit or hover.
  const [surfaceHeld, setSurfaceHeld] = useState(false);
  const { visible, holdProps } = useGroupOrder(
    {
      rows: props.rows,
      columns: props.columns,
      sort: props.sort,
      open,
      limit: showAll ? null : activeLimit(props),
      withAfter: props.afterMembers !== undefined,
    },
    {
      freezeOrderOnHover: props.freezeOrderOnHover ?? false,
      when: props.selectable && surfaceHeld,
    }
  );
  const colSpan = 1 + props.columns.length + (props.selectable ? 2 : 0);
  const body: BodyProps<G, M> = {
    table: props,
    visible,
    colSpan,
    holdProps,
    renderRow: (row) => (
      <BodyRow table={props} row={row} colSpan={colSpan} onToggle={toggle} />
    ),
    trailing: (
      <>
        <ShowAllRow
          table={props}
          colSpan={colSpan}
          showAll={showAll}
          onToggle={() => setShowAll((v) => !v)}
        />
        {props.after?.({ colSpan, selectable: props.selectable })}
      </>
    ),
  };
  const table =
    props.height === undefined ? (
      <PlainTable {...body} />
    ) : (
      <VirtualTable {...body} height={props.height} />
    );
  if (!props.selectable) return table;
  return (
    <SelectionSurface
      table={props}
      visible={visible}
      onHoldChange={setSurfaceHeld}
    >
      {table}
    </SelectionSurface>
  );
}

const sortKey = (sort: ColumnSort<string>) => `${sort.by}:${sort.dir}`;

/** The shared selection, Quit flow and selection bar around a selectable table. */
function SelectionSurface<G, M>({
  table,
  visible,
  onHoldChange,
  children,
}: {
  table: Props<G, M>;
  visible: readonly VisibleRow<G, M>[];
  onHoldChange: (held: boolean) => void;
  children: ReactNode;
}) {
  const allTargets = useStableTargets(visibleTargets(visible, table.rows));
  return (
    <ProcessSelectionSurface
      rows={selectionRows(visible, table.rows)}
      allTargets={allTargets}
      {...(table.scopeKey === undefined ? {} : { scopeKey: table.scopeKey })}
      {...(table.sort ? { orderKey: sortKey(table.sort.value) } : {})}
      {...(table.height === undefined
        ? {}
        : { height: table.height + HEAD_PX + SELECTION_BAR_PX })}
      onHoldChange={onHoldChange}
    >
      {children}
    </ProcessSelectionSurface>
  );
}

/** One visible row: a group, a member, or the page's rows under an open group. */
function BodyRow<G, M>({
  table,
  row,
  colSpan,
  onToggle,
}: {
  table: Props<G, M>;
  row: VisibleRow<G, M>;
  colSpan: number;
  onToggle: (key: string) => void;
}) {
  const { rows, columns, selectable } = table;
  if (row.kind === "after") return table.afterMembers?.(row.group, colSpan);
  if (row.kind === "member") {
    return (
      <MemberRow
        member={row.member}
        rows={rows}
        columns={columns}
        actions={selectable === true}
      />
    );
  }
  return (
    <GroupRow
      group={row.group}
      rows={rows}
      columns={columns}
      actions={selectable === true}
      expandable={row.expandable}
      open={row.open}
      onToggle={() => onToggle(row.key)}
    />
  );
}

/** The group limit in force: none while searching or without `limit`. */
function activeLimit(
  table: Pick<Props<unknown, unknown>, "limit" | "searching">
): number | null {
  if (table.limit === undefined || table.searching) return null;
  return table.limit;
}

/** The Show all / Show top N toggle under a limited list of groups. */
function ShowAllRow<G, M>({
  table,
  colSpan,
  showAll,
  onToggle,
}: {
  table: Props<G, M>;
  colSpan: number;
  showAll: boolean;
  onToggle: () => void;
}) {
  const limit = activeLimit(table);
  const total = table.rows.groups.length;
  if (limit === null || total <= limit) return null;
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={colSpan} className="px-3 py-1.5">
        <button
          type="button"
          onClick={onToggle}
          className="rounded-chip font-medium text-fg-subtle text-small outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {showAll ? `Show top ${limit}` : `Show all ${total} apps`}
        </button>
      </TableCell>
    </TableRow>
  );
}
