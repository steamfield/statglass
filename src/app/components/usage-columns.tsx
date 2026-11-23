/**
 * The usage table's columns: the page's figure columns, then Share, as the
 * group, member and remainder rows render them, and the ranked column as
 * the table's (Rust-chosen) order.
 */
import { percentOf } from "@core/chart-math";
import type { ProcessUsage } from "@core/generated/bindings";
import { type RemainderRow, type UsageRow, usageValue } from "@core/usage-rows";
import type { ReactNode } from "react";
import { ShareMeter } from "~/components/app-table";
import type { ClientSort, GroupColumn } from "~/components/process-group-table";
import type { UsageTableConfig } from "~/components/usage-table-config";
import { cn } from "~/lib/utils";

type UsageGroupColumn = GroupColumn<UsageRow, ProcessUsage>;

/** Column id of the Share column; figure columns go by their label. */
const SHARE = "share";

/** Right-aligned figure in a usage cell; the ranked one is brighter on app rows. */
function Figure({ strong, children }: { strong: boolean; children: string }) {
  return (
    <span className={cn("figures", strong && "text-foreground")}>
      {children}
    </span>
  );
}

/**
 * The page's figure columns, then Share when the key adds up (`whole` is
 * what shares are of; null leaves Share out). None sorts: Rust ranks.
 */
export function usageGroupColumns(
  config: UsageTableConfig,
  whole: number | null
): UsageGroupColumn[] {
  const figures = config.columns.map(
    (c): UsageGroupColumn => ({
      id: c.label,
      header: c.label,
      align: "right",
      sortable: false,
      group: (r) => (
        <Figure strong={c.ranked === true}>{c.format(r.app)}</Figure>
      ),
      member: (p) => <Figure strong={false}>{c.format(p)}</Figure>,
    })
  );
  if (whole === null) return figures;
  return [
    ...figures,
    {
      id: SHARE,
      header: "Share",
      align: "right",
      group: (r) => <ShareMeter share={r.share} muted={false} />,
      member: (p) => (
        <ShareMeter share={percentOf(usageValue(config.by, p), whole)} muted />
      ),
    },
  ];
}

/** A remainder row's ("Other apps", "System and other") content in `column`. */
export function remainderCell(
  config: UsageTableConfig,
  row: RemainderRow
): (column: UsageGroupColumn) => ReactNode {
  return (column) => {
    if (column.id === SHARE) return <ShareMeter share={row.share} muted />;
    const figure = config.columns.find((c) => c.label === column.id);
    return (
      figure && <Figure strong={false}>{figure.format(row.figures)}</Figure>
    );
  };
}

/** `ClientSort.onChange` for a table with no sortable header: never called. */
function unsortable(): void {
  return;
}

/**
 * The ranked column, high to low, as the table's order: its header shows
 * the direction. No header sorts, since Rust ranks the rows by the page's
 * key; undefined when no column is ranked.
 */
export function rankedSort(config: UsageTableConfig): ClientSort | undefined {
  const ranked = config.columns.find((c) => c.ranked);
  if (ranked === undefined) return undefined;
  return {
    value: { by: ranked.label, dir: "desc" },
    onChange: unsortable,
    client: false,
    nameSortable: false,
  };
}
