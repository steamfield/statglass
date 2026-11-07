import type {
  DockerContainer,
  DockerRankedContainer,
} from "@core/generated/bindings";
import type { Row } from "@tanstack/react-table";
import type { Virtualizer } from "@tanstack/react-virtual";
import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router";
import {
  DataTable,
  DataTableHead,
  type TableFeatures,
  useColumnSort,
  useDataTable,
  useGroupedRows,
} from "~/components/data-table";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "~/components/ui/context-menu";
import { useUnits } from "~/hooks/use-units";
import {
  containerReturnState,
  isContainerDetailClick,
} from "../_lib/navigation";
import {
  type ContainerSort,
  containerPath,
  DEFAULT_CONTAINER_SORT,
  isContainerSortColumn,
} from "../_lib/presentation";
import {
  ContainerActionMenuItem,
  containerAction,
  useContainerActions,
} from "./container-actions";
import {
  containerRowId,
  containerTiebreak,
  useContainerColumns,
} from "./container-columns";
import { ContainerDataRow } from "./container-data-row";

/** `max-h-88`: the scroller's height before layout measures it. */
const TABLE_MAX_PX = 352;
const projectOf = (row: DockerContainer) => row.project ?? "Standalone";
export const needsAttention = (row: DockerContainer) =>
  row.health === "unhealthy" || row.oom_killed || row.repeated_restarts;
export function ContainerTable({
  rows,
  sort,
  onSort,
  grouped,
  collapsed = [],
  onCollapse,
  slots = {},
  focused = null,
  onFocus,
  columns = [],
  filters,
  attention,
  historical = false,
  title = "Containers now",
  liveRows,
  summaries,
}: {
  rows: readonly DockerContainer[];
  sort: ContainerSort;
  onSort: (sort: ContainerSort) => void;
  grouped: boolean;
  collapsed?: readonly string[];
  onCollapse: (group: string) => void;
  slots?: Record<string, number>;
  focused?: string | null;
  onFocus?: (id: string | null) => void;
  columns?: readonly string[];
  filters?: ReactNode;
  attention?: ReactNode;
  historical?: boolean;
  title?: string;
  liveRows?: readonly DockerContainer[];
  summaries?: readonly DockerRankedContainer[] | undefined;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const actions = useContainerActions();
  const { bytes, rate } = useUnits();
  const summaryById = new Map(summaries?.map((row) => [row.container.id, row]));
  const scroller = useRef<HTMLDivElement>(null);
  const virtual = useRef<Virtualizer<HTMLDivElement, Element>>(null);
  const [contextId, setContextId] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const contextRow = (liveRows ?? (historical ? [] : rows)).find(
    (row) => row.id === contextId
  );
  const definitions = useContainerColumns(columns, historical);
  const sortIds = useMemo(
    () =>
      definitions.flatMap((column) => {
        const id =
          column.id ??
          ("accessorKey" in column ? column.accessorKey : undefined);
        return id && isContainerSortColumn(id) ? [id] : [];
      }),
    [definitions]
  );
  const activeSort = sortIds.includes(sort.by) ? sort : DEFAULT_CONTAINER_SORT;
  const { sorting, onSortingChange } = useColumnSort(
    activeSort,
    onSort,
    sortIds
  );
  const model = useDataTable({
    data: rows,
    columns: definitions,
    getRowId: containerRowId,
    tiebreak: containerTiebreak,
    sorting,
    onSortingChange,
    hold: { when: contextOpen || actions.pendingIds.size > 0 },
  });
  const { hovered, holdProps } = model;
  const visibleColumns = model.table.getAllLeafColumns();
  const items = useGroupedRows({
    rows: model.rows,
    grouped,
    groupOf: projectOf,
    getRowId: containerRowId,
    collapsed,
  });
  useEffect(() => {
    const saved =
      (location.state as { tableScroll?: number } | null)?.tableScroll ??
      window.history.state?.containerTableScroll;
    if (typeof saved === "number" && scroller.current)
      scroller.current.scrollTop = saved;
  }, [location.state]);
  useEffect(() => {
    if (!focused || hovered) return;
    const index = items.findIndex(
      (item) => !item.getIsGrouped() && item.id === focused
    );
    if (index < 0) return;
    if (rows.length > 100)
      virtual.current?.scrollToIndex(index, { align: "auto" });
    else {
      scrollFocusedRow(scroller.current, focused);
    }
  }, [focused, hovered, items, rows.length]);
  const count = visibleColumns.length;
  const openDetail = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, engine: string, id: string) => {
      if (!isContainerDetailClick(event)) return;
      event.preventDefault();
      void navigate(containerPath(engine, id), {
        state: containerReturnState(location, scroller.current),
      });
    },
    [navigate, location]
  );
  const render = (item: Row<TableFeatures, DockerContainer>) => {
    if (item.getIsGrouped()) {
      const group = projectOf(item.original);
      return (
        <tr key={item.id} className="h-11 bg-raised/40">
          <th colSpan={count} className="px-3 text-left">
            <button
              className="w-full text-left text-[12px]"
              type="button"
              aria-expanded={!collapsed.includes(group)}
              onClick={() => onCollapse(group)}
            >
              {collapsed.includes(group) ? "›" : "⌄"} {group}
              <span className="ml-2 font-normal text-muted-foreground">
                {item.subRows.length} containers
              </span>
            </button>
          </th>
        </tr>
      );
    }
    const row = item.original;
    return (
      <ContainerDataRow
        key={row.id}
        row={row}
        summary={historical ? summaryById.get(row.id) : undefined}
        current={
          liveRows?.find((r) => r.id === row.id) ?? (historical ? null : row)
        }
        slot={slots[row.id]}
        isFocused={focused === row.id}
        onFocus={onFocus}
        failure={actions.failures[row.id]}
        openDetail={openDetail}
        historical={historical}
        columns={visibleColumns}
        bytes={bytes}
        rate={rate}
      />
    );
  };
  return (
    <div className="@container">
      <div className="flex flex-wrap items-center gap-3 px-3 py-2">
        <p className="mr-auto text-[14px]">{title}</p>
        {filters}
        <span className="text-[11px] text-muted-foreground">
          {rows.length} matching containers
        </span>
        {attention}
      </div>
      <ContextMenu onOpenChange={setContextOpen}>
        <ContextMenuTrigger asChild>
          <div
            onContextMenuCapture={(event) => {
              const target =
                event.target instanceof Element
                  ? event.target.closest<HTMLElement>("tr[data-container-id]")
                  : null;
              const row = (liveRows ?? (historical ? [] : rows)).find(
                (candidate) => candidate.id === target?.dataset.containerId
              );
              if (!row || !containerAction(row)) {
                event.preventDefault();
                setContextId(null);
                return;
              }
              setContextId(row.id);
            }}
            data-container-table-scroll
            ref={scroller}
            className="max-h-88 overflow-y-scroll"
            {...holdProps}
            onPointerLeave={() => {
              holdProps.onPointerLeave();
              onFocus?.(null);
            }}
            onBlurCapture={(event) => {
              holdProps.onBlurCapture(event);
              if (!event.currentTarget.contains(event.relatedTarget))
                onFocus?.(null);
            }}
          >
            <table
              className="w-full table-fixed border-collapse"
              aria-label={title}
            >
              <thead className="sticky top-0 z-10 border-border border-y bg-card text-[11px] text-muted-foreground">
                <DataTableHead table={model.table} />
              </thead>
              <DataTable
                variant="plain"
                table={model.table}
                rows={items}
                renderRow={render}
                virtual={{
                  scrollRef: scroller,
                  estimateSize: 44,
                  overscan: 5,
                  initialHeight: TABLE_MAX_PX,
                  enabled: rows.length > 100,
                  ref: virtual,
                }}
              />
            </table>
            {!rows.length && (
              <p className="px-3 py-8 text-[12px] text-muted-foreground">
                No containers match this view.
              </p>
            )}
          </div>
        </ContextMenuTrigger>
        {contextRow && (
          <ContextMenuContent>
            <ContainerActionMenuItem row={contextRow} />
          </ContextMenuContent>
        )}
      </ContextMenu>
    </div>
  );
}

function scrollFocusedRow(scroller: HTMLDivElement | null, focused: string) {
  const row = scroller?.querySelector(
    `[data-container-id="${CSS.escape(focused)}"]`
  );
  if (row && scroller) {
    const bounds = row.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    if (bounds.top < view.top + 32 || bounds.bottom > view.bottom)
      row.scrollIntoView({ block: "nearest" });
  }
}
