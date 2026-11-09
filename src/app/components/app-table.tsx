import { formatPercent } from "@core/format";
import type { UsageRow } from "@core/usage-rows";
import type { Table } from "@tanstack/react-table";
import type { ReactNode } from "react";
import {
  columnHelper,
  DataTableHead,
  MeterCell,
  type TableFeatures,
} from "~/components/data-table";
import { InlineMessage } from "~/components/inline-message";
import { ProcessSelectionHead } from "~/components/process-selection";
import { SectionCard } from "~/components/section-card";
import { TableCell, TableHead, TableRow } from "~/components/ui/table";
import { cn } from "~/lib/utils";
import type { Accent } from "~/widgets/lib/accent";

/**
 * Parts of the per-app tables: the Network Apps card and the Power
 * page's energy table (D-093), which follows it.
 */

/** Cell padding and size shared by the per-app tables. */
export const APP_CELL = "px-3 py-1.75 text-small whitespace-nowrap";

/**
 * The card shell: title with its scope, controls or the pinned
 * selection's chip on the right, then notes and the table edge to edge.
 */
export function AppsShell({
  title,
  aside,
  accent = "net",
  children,
}: {
  title: string;
  aside?: ReactNode;
  accent?: Accent;
  children?: ReactNode;
}) {
  return (
    <SectionCard
      accent={accent}
      origin="tr"
      variant="default"
      title={title}
      aside={aside}
      headerAlign="center"
      compactHeader
      flush
      className="pb-1"
    >
      {children}
    </SectionCard>
  );
}

export function AppsNote({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 pb-2">
      <InlineMessage tone="note">{children}</InlineMessage>
    </div>
  );
}

/**
 * A range with nothing recorded in it: a hatched box with a chip saying so
 * (and, when known, when recording started).
 */
export function UnrecordedRange({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 pt-1 pb-3.5">
      <div className="flex h-33 items-center justify-center rounded-tile border border-border-strong/40 border-dashed bg-gap-hatch">
        <span className="rounded-control border border-border bg-card px-2 py-1 font-normal text-fg-subtle text-label">
          {children}
        </span>
      </div>
    </div>
  );
}

/** The dashed square that marks a remainder row ("System and other"). */
export function OtherChip() {
  return (
    <span
      aria-hidden
      className="inline-block size-4 flex-none rounded-chip border border-border-strong/50 border-dashed"
    />
  );
}

/**
 * A remainder row after the apps ("Other apps", "System and other"): muted,
 * a rule above the first, a dashed square marking the system row. `indent`
 * leaves room for the expand chevron the app rows above have. `children`
 * are the figure cells.
 */
export function OtherAppsRow({
  name,
  system,
  first,
  indent = false,
  children,
  selectionCell,
}: {
  name: string;
  system: boolean;
  first: boolean;
  indent?: boolean;
  children: ReactNode;
  selectionCell?: ReactNode;
}) {
  return (
    <TableRow
      className={cn(
        "text-muted-foreground",
        first && "border-border border-t",
        system && "border-b-0"
      )}
    >
      {selectionCell}
      <TableCell className={APP_CELL}>
        <span className="inline-flex items-center gap-2">
          {indent && <span aria-hidden className="-ml-1 inline-block size-4" />}
          {system ? (
            <OtherChip />
          ) : (
            <span aria-hidden className="inline-block w-4 flex-none" />
          )}
          {name}
        </span>
      </TableCell>
      {children}
    </TableRow>
  );
}

/** A share of the whole, percent: a meter in the card accent and the figure. */
export function ShareCell({
  share,
  muted,
}: {
  share: number | null;
  muted: boolean;
}) {
  return (
    <TableCell className={cn(APP_CELL, "text-right")}>
      <MeterCell
        fraction={share === null ? null : share / 100}
        fill={muted ? "var(--color-fg-faint)" : "var(--a)"}
      >
        {formatPercent(share, { decimals: 1 })}
      </MeterCell>
    </TableCell>
  );
}

const usageHelper = columnHelper<UsageRow>();
export const usageRowId = (row: UsageRow) => row.app.name;

/** The app, then the page's figures; Rust ranks the rows, so none sorts. */
export function usageColumns(
  columns: readonly { label: string; ranked?: boolean }[]
) {
  return usageHelper.columns([
    usageHelper.display({
      id: "app",
      header: "App",
      meta: { align: "left" },
    }),
    ...columns.map((column) =>
      usageHelper.display({
        id: column.label,
        header: column.label,
        meta: {
          align: "right",
          ...(column.ranked ? { ranked: true } : {}),
        },
      })
    ),
  ]);
}

export function UsageHead({
  table,
  share,
}: {
  table: Table<TableFeatures, UsageRow>;
  share: boolean;
}) {
  return (
    <DataTableHead
      table={table}
      leading={<ProcessSelectionHead />}
      trailing={
        <>
          {share && <TableHead className="text-right">Share</TableHead>}
          <TableHead className="w-[132px]">
            <span className="sr-only">Actions</span>
          </TableHead>
        </>
      }
    />
  );
}
