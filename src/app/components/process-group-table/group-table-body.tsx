/**
 * The grouped table's two bodies: a plain one that renders every visible
 * row, and a virtual one at a fixed height that renders only the rows near
 * the viewport and lets the selection surface scroll a row into view.
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
} from "react";
import { FullWidthRow } from "~/components/data-table";
import {
  SELECTION_BAR_PX,
  useProcessSelection,
} from "~/components/process-selection";
import { Table, TableBody, TableCell, TableRow } from "~/components/ui/table";
import { GroupTableHead } from "./group-table-head";
import type { ProcessGroupTableProps } from "./types";
import type { useGroupOrder, VisibleRow } from "./use-group-order";

/** Row height in px: 12 px text plus 7 px padding top and bottom, plus a hairline. */
const ROW_H = 29;

/** Header row plus the 4 px slack below a scrolling body. */
export const HEAD_PX = ROW_H + 4;

/** Rows rendered past each edge of the virtual viewport. */
const OVERSCAN = 6;

type Props<G, M> = ProcessGroupTableProps<G, M>;

/** What both bodies draw from. */
export interface BodyProps<G, M> {
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
export function PlainTable<G, M>(body: BodyProps<G, M>) {
  return (
    // `relative` keeps the header's absolutely placed sr-only labels inside
    // the scroller, or they widen the page on a narrow window.
    <div className="relative overflow-x-auto" {...body.holdProps}>
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
export function VirtualTable<G, M>(body: BodyProps<G, M> & { height: number }) {
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
      className="relative min-h-0 overflow-auto"
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
