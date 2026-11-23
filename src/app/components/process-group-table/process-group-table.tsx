/**
 * The one table every process and per-app view renders: app groups that
 * expand to their processes, shared selection, Quit and Force Quit, client or
 * Rust-ranked order, row hold, and virtualization for the full process list.
 * This file wires those together and draws the header and the two bodies
 * (plain, and virtual at a fixed height); rows live in `group-row` and
 * `member-row`, order in `use-group-order`.
 */
import {
  observeElementRect,
  useVirtualizer,
  type Virtualizer,
} from "@tanstack/react-virtual";
import {
  Fragment,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { type ColumnSort, FullWidthRow } from "~/components/data-table";
import {
  ProcessSelectionHead,
  ProcessSelectionSurface,
  SELECTION_BAR_PX,
  useProcessSelection,
} from "~/components/process-selection";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
} from "~/components/ui/table";
import { cn } from "~/lib/utils";
import { GroupRow } from "./group-row";
import { MemberRow } from "./member-row";
import type { ClientSort, ProcessGroupTableProps } from "./types";
import {
  NAME_COLUMN,
  selectionRows,
  useGroupOrder,
  useStableTargets,
  type VisibleRow,
  visibleTargets,
} from "./use-group-order";

/** Row height in px: 12 px text plus 7 px padding top and bottom, plus a hairline. */
const ROW_H = 29;

/** Header row plus the 4 px slack below a scrolling body. */
const HEAD_PX = ROW_H + 4;

/** Rows rendered past each edge of the virtual viewport. */
const OVERSCAN = 6;

const HEADER = "h-auto whitespace-nowrap border-border border-b";

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
  const { open, toggle } = useExpansion(props.expansion);
  const [showAll, setShowAll] = useState(false);
  // The selection surface holds for a selection, a pending quit or hover.
  const [surfaceHeld, setSurfaceHeld] = useState(false);
  const { visible, holdProps, release } = useGroupOrder(
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
  useEffect(() => release, [release]);
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
        {props.after?.(colSpan)}
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
  const allTargets = useStableTargets(
    table.allTargets ?? visibleTargets(visible, table.rows)
  );
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
        actions={selectable}
      />
    );
  }
  return (
    <GroupRow
      group={row.group}
      rows={rows}
      columns={columns}
      actions={selectable}
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

/** One column header; a button that sorts by it when the column is sortable. */
function HeadCell({
  id,
  align,
  sort,
  className,
  children,
}: {
  id: string;
  align: "left" | "right";
  /** Absent: the column does not sort. */
  sort: ClientSort | undefined;
  className: string | undefined;
  children: ReactNode;
}) {
  const dir = sort?.value.by === id ? sort.value.dir : null;
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
          {dir && <span aria-hidden>{dir === "desc" ? " ↓" : " ↑"}</span>}
        </button>
      ) : (
        children
      )}
    </TableHead>
  );
}

/** The header row: selection gutter, name, config columns, actions. */
function GroupTableHead<G, M>({
  table,
  sticky,
}: {
  table: Props<G, M>;
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
          sort={sort}
          className={undefined}
        >
          {table.nameHeader}
        </HeadCell>
        {columns.map((c) => (
          <HeadCell
            key={c.id}
            id={c.id}
            align={c.align}
            sort={c.groupValue || c.memberValue ? sort : undefined}
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

/** What both bodies draw from. */
interface BodyProps<G, M> {
  table: Props<G, M>;
  visible: readonly VisibleRow<G, M>[];
  colSpan: number;
  holdProps: ReturnType<typeof useGroupOrder>["holdProps"];
  renderRow: (row: VisibleRow<G, M>) => ReactNode;
  /** Show all, then the page's `after` rows. */
  trailing: ReactNode;
}

/** The empty row while there are no groups. */
function EmptyRow<G, M>({
  table,
  colSpan,
}: {
  table: Props<G, M>;
  colSpan: number;
}) {
  if (table.rows.groups.length > 0) return null;
  return <FullWidthRow colSpan={colSpan}>{table.empty}</FullWidthRow>;
}

/** Every visible row in the document, for short tables without a fixed height. */
function PlainTable<G, M>(body: BodyProps<G, M>) {
  return (
    <div className="overflow-x-auto" {...body.holdProps}>
      <Table
        aria-label={body.table.ariaLabel}
        className="w-full border-collapse text-small"
      >
        <GroupTableHead table={body.table} sticky={false} />
        <TableBody>
          <EmptyRow table={body.table} colSpan={body.colSpan} />
          {body.visible.map((row) => (
            <Fragment key={row.key}>{body.renderRow(row)}</Fragment>
          ))}
          {body.trailing}
        </TableBody>
      </Table>
    </div>
  );
}

/** Lets the selection surface scroll a row into view by key (keyboard moves). */
function useReveal(
  visible: readonly { key: string }[],
  virtualizer: RefObject<Virtualizer<HTMLDivElement, Element> | null>
) {
  const revealRef = useProcessSelection()?.reveal;
  useEffect(() => {
    if (!revealRef) return;
    revealRef.current = (key) => {
      const index = visible.findIndex((row) => row.key === key);
      if (index >= 0) virtualizer.current?.scrollToIndex(index);
    };
    return () => {
      revealRef.current = null;
    };
  }, [revealRef, visible, virtualizer]);
}

/**
 * A scrolling body `height` px tall (plus the selection bar's room when
 * selectable) that renders only the rows near the viewport.
 */
function VirtualTable<G, M>(body: BodyProps<G, M> & { height: number }) {
  const { visible, colSpan, table } = body;
  const viewport = body.height + (table.selectable ? SELECTION_BAR_PX : 0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    getItemKey: (index) => visible[index]?.key ?? index,
    overscan: OVERSCAN,
    initialRect: { width: 0, height: viewport },
    // Hidden windows and test DOMs measure zero until layout is available.
    observeElementRect: (instance, cb) =>
      observeElementRect(instance, (rect) =>
        cb(rect.height > 0 ? rect : { ...rect, height: viewport })
      ),
  });
  const virtualRef = useRef(virtualizer);
  virtualRef.current = virtualizer;
  useReveal(visible, virtualRef);
  const items = virtualizer.getVirtualItems();
  const padTop = items[0]?.start ?? 0;
  const padBottom = virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0);
  return (
    <div
      ref={scrollRef}
      data-testid="process-table-scroll"
      data-process-scroll
      className="min-h-0 overflow-auto"
      style={{ maxHeight: viewport + HEAD_PX }}
      {...body.holdProps}
    >
      <Table
        aria-label={table.ariaLabel}
        className="w-full border-collapse text-small"
      >
        <GroupTableHead table={table} sticky />
        <TableBody
          className={
            visible.length > 0
              ? "[&_tr:last-child]:border-b [&_tr[aria-hidden]]:border-0"
              : undefined
          }
        >
          <Spacer height={padTop} colSpan={colSpan} />
          <EmptyRow table={table} colSpan={colSpan} />
          {items.map((item) => {
            const row = visible[item.index];
            return (
              row && <Fragment key={row.key}>{body.renderRow(row)}</Fragment>
            );
          })}
          <Spacer height={padBottom} colSpan={colSpan} />
          {body.trailing}
        </TableBody>
      </Table>
    </div>
  );
}

/** Stands in for the rows scrolled out of a virtual body. */
function Spacer({ height, colSpan }: { height: number; colSpan: number }) {
  if (height <= 0) return null;
  return (
    <TableRow
      aria-hidden
      style={{ height }}
      className="border-0 transition-none hover:bg-transparent"
    >
      <TableCell colSpan={colSpan} className="p-0" />
    </TableRow>
  );
}
