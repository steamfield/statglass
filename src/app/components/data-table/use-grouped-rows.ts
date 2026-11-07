import {
  type ExpandedState,
  type Row,
  type RowData,
  useTable,
} from "@tanstack/react-table";
import { useMemo } from "react";
import { columnHelper, features, type TableFeatures } from "./features";

const GROUP = "group";
const GROUPING = [GROUP];

/**
 * Group a body's rows (`useDataTable(...).rows`) under `groupOf`, as group
 * rows from TanStack's grouped model with their members after them. It
 * groups the rows in the order given, so a group sits where its first member
 * sorts and members keep their sorted and held order. A collapsed group
 * keeps its row and drops its members (TanStack `expanded`). Group rows
 * carry no aggregates; `subRows.length` is the member count.
 */
export function useGroupedRows<T extends RowData>({
  rows,
  grouped,
  groupOf,
  getRowId,
  collapsed,
}: {
  rows: readonly Row<TableFeatures, T>[];
  /** Off: `rows` come back as they are. */
  grouped: boolean;
  /** Stable: the grouping column's accessor. */
  groupOf: (row: T) => string;
  getRowId: (row: T) => string;
  collapsed: readonly string[];
}) {
  const data = useMemo(
    () => (grouped ? rows.map((row) => row.original) : []),
    [rows, grouped]
  );
  const columns = useMemo(() => {
    const helper = columnHelper<T>();
    return helper.columns([helper.accessor(groupOf, { id: GROUP })]);
  }, [groupOf]);
  const expanded = useMemo<ExpandedState>(
    () =>
      Object.fromEntries(
        data.map((row) => {
          const group = groupOf(row);
          return [`${GROUP}:${group}`, !collapsed.includes(group)];
        })
      ),
    [data, groupOf, collapsed]
  );
  const table = useTable(
    {
      features,
      data,
      columns,
      getRowId,
      state: { grouping: GROUPING, expanded },
      autoResetExpanded: false,
    },
    (state) => ({ grouping: state.grouping, expanded: state.expanded })
  );
  const groupedRows = table.getRowModel().rows;
  return grouped ? groupedRows : rows;
}
