import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { columnHelper } from "./features";
import { useDataTable } from "./use-data-table";
import { useGroupedRows } from "./use-grouped-rows";

interface Item {
  id: string;
  group: string;
  value: number;
}
const helper = columnHelper<Item>();
const columns = helper.columns([
  helper.accessor("value", { header: "Value", meta: { align: "right" } }),
]);
const getRowId = (item: Item) => item.id;
const groupOf = (item: Item) => item.group;
const items: Item[] = [
  { id: "a1", group: "a", value: 1 },
  { id: "b1", group: "b", value: 9 },
  { id: "a2", group: "a", value: 5 },
  { id: "b2", group: "b", value: 3 },
];

function useGrouped(collapsed: readonly string[], grouped = true) {
  const model = useDataTable({
    data: items,
    columns,
    getRowId,
    initialSorting: [{ id: "value", desc: true }],
  });
  return useGroupedRows({
    rows: model.rows,
    grouped,
    groupOf,
    getRowId,
    collapsed,
  });
}

const shape = (rows: ReturnType<typeof useGrouped>) =>
  rows.map((row) =>
    row.getIsGrouped() ? `${row.id} (${row.subRows.length})` : row.id
  );

describe("useGroupedRows", () => {
  it("orders groups by their first sorted member and keeps members sorted", () => {
    const { result } = renderHook(() => useGrouped([]));
    expect(shape(result.current)).toEqual([
      "group:b (2)",
      "b1",
      "b2",
      "group:a (2)",
      "a2",
      "a1",
    ]);
  });

  it("keeps a collapsed group's row and count and drops its members", () => {
    const { result } = renderHook(() => useGrouped(["b"]));
    expect(shape(result.current)).toEqual([
      "group:b (2)",
      "group:a (2)",
      "a2",
      "a1",
    ]);
  });

  it("passes rows through when grouping is off", () => {
    const { result } = renderHook(() => useGrouped([], false));
    expect(shape(result.current)).toEqual(["b1", "a2", "b2", "a1"]);
  });
});
