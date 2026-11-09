import { ratio } from "@core/chart-math";
import {
  type ByteUnits,
  fixed,
  formatBytes,
  formatPercent,
  formatRate,
  MISSING,
  type RateUnits,
} from "@core/format";
import { constructRow, type Table } from "@tanstack/react-table";
import { type ReactNode, useMemo } from "react";
import { OtherChip } from "~/components/app-table";
import {
  columnHelper,
  DataTable,
  DataTableCells,
  DataTableHead,
  gap,
  MeterCell,
  type TableFeatures,
  useColumnSort,
  useDataTable,
} from "~/components/data-table";
import { cn } from "~/lib/utils";
import { InitialChip } from "~/widgets/initial-chip";
import {
  type CgroupColumn,
  type CgroupRow,
  type CgroupSort,
  DEFAULT_SORT,
  KIND_LABEL,
} from "../_lib/cgroups";

interface CellCtx {
  bytes: ByteUnits;
  rate: RateUnits;
}

const figure = (text: string, className?: string) => (
  <span className={cn("figures", className)}>{text}</span>
);

/** Row id of the pinned "N others" remainder; real rows are `kind/name`. */
const REMAINDER_ID = "_other";
const helper = columnHelper<CgroupRow>();
const getRowId = (row: CgroupRow) => row.id;
const byName = (a: CgroupRow, b: CgroupRow) =>
  a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const HEADER = "h-auto whitespace-nowrap border-border border-b";
const STATIC_COLUMNS = {
  name: helper.accessor((r) => r.name, {
    id: "name",
    header: "Name",
    sortFn: "text",
    meta: { align: "left", className: HEADER },
    cell: ({ row }) =>
      row.id === REMAINDER_ID ? (
        <OtherName label={row.original.name} />
      ) : (
        <span className="inline-flex max-w-72 items-center gap-2 text-foreground">
          <InitialChip text={row.original.name} />
          <span className="truncate" title={row.original.name}>
            {row.original.name}
          </span>
        </span>
      ),
  }),
  kind: helper.accessor((r) => KIND_LABEL[r.kind], {
    id: "kind",
    header: "Kind",
    sortFn: "text",
    meta: { align: "left", className: HEADER },
    cell: ({ row }) =>
      row.id === REMAINDER_ID
        ? null
        : figure(KIND_LABEL[row.original.kind], "text-muted-foreground"),
  }),
  // Percent of one core, so the bar fills at one core and the figure can pass 100.
  cpu: helper.accessor((r) => gap(r.cpu), {
    id: "cpu",
    header: "% CPU",
    meta: { align: "right", className: HEADER },
    cell: ({ row: { original: r } }) => (
      <MeterCell
        fraction={ratio(r.cpu, 100)}
        fill="var(--color-cpu)"
        className="text-foreground"
      >
        {r.cpu === null ? MISSING : fixed(r.cpu, 1)}
      </MeterCell>
    ),
  }),
  memPsi: helper.accessor((r) => gap(r.memPsi), {
    id: "memPsi",
    header: "Memory pressure",
    meta: { align: "right", className: HEADER },
    cell: ({ row }) =>
      row.id === REMAINDER_ID
        ? null
        : figure(formatPercent(row.original.memPsi, { decimals: 1 })),
  }),
};

function cgroupColumns(c: CellCtx) {
  return {
    ...STATIC_COLUMNS,
    mem: helper.accessor((r) => gap(r.mem), {
      id: "mem",
      header: "Memory",
      meta: { align: "right", className: HEADER },
      cell: ({ row: { original: r } }) => {
        const used = figure(formatBytes(r.mem, { units: c.bytes }));
        if (r.memMax === null) return used;
        return (
          <MeterCell
            fraction={ratio(r.mem, r.memMax)}
            fill="var(--color-mem)"
            figure="ratio"
          >
            {used}
            {figure(
              ` / ${formatBytes(r.memMax, { units: c.bytes })}`,
              "text-muted-foreground"
            )}
          </MeterCell>
        );
      },
    }),
    ioRead: helper.accessor((r) => gap(r.ioRead), {
      id: "ioRead",
      header: "Disk read",
      meta: { align: "right", className: HEADER },
      cell: ({ row: { original: r } }) =>
        figure(formatRate(r.ioRead, { units: c.rate })),
    }),
    ioWrite: helper.accessor((r) => gap(r.ioWrite), {
      id: "ioWrite",
      header: "Disk write",
      meta: { align: "right", className: HEADER },
      cell: ({ row: { original: r } }) =>
        figure(formatRate(r.ioWrite, { units: c.rate })),
    }),
  };
}

const CELL = "whitespace-nowrap px-3 py-0 font-normal text-fg-subtle";

export interface CgroupTableProps {
  rows: readonly CgroupRow[];
  /** The folded remainder, pinned last whatever the sort. */
  other: { label: string; row: CgroupRow } | null;
  columns: readonly CgroupColumn[];
  sort: CgroupSort;
  onSort: (sort: CgroupSort) => void;
  bytes: ByteUnits;
  rate: RateUnits;
  empty: ReactNode;
}

/**
 * cgroup groups on a Linux host, styled like the process table. Row order
 * holds while the pointer is over the table, as on Processes; a sort the
 * user picks applies at once.
 */
export function CgroupTable({
  rows,
  other,
  columns,
  sort,
  onSort,
  bytes,
  rate,
  empty,
}: CgroupTableProps) {
  const activeSort = columns.includes(sort.by) ? sort : DEFAULT_SORT;
  const { sorting, onSortingChange } = useColumnSort(
    activeSort,
    onSort,
    columns
  );
  const definitions = useMemo(() => {
    const definitions = cgroupColumns({ bytes, rate });
    return helper.columns(columns.map((id) => definitions[id]));
  }, [columns, bytes, rate]);
  const data = useDataTable({
    data: rows,
    columns: definitions,
    getRowId,
    tiebreak: byName,
    sorting,
    onSortingChange,
    hold: {},
  });
  return (
    <div className="min-h-0 overflow-auto" {...data.holdProps}>
      <table
        aria-label="Services and containers"
        className="w-full border-collapse text-small"
      >
        <thead className="sticky top-0 z-10 bg-card">
          <DataTableHead table={data.table} />
        </thead>
        <DataTable
          table={data.table}
          rows={data.rows}
          className={
            other
              ? "[&_tr:last-child]:border-t"
              : rows.length > 0
                ? "[&_tr:last-child]:border-b"
                : undefined
          }
          renderRow={(row) => (
            <tr
              key={row.id}
              className="h-[29px] border-border-subtle border-b hover:bg-selected"
            >
              <DataTableCells row={row} className={CELL} />
            </tr>
          )}
          empty={empty}
          after={
            other && (
              <OtherRow
                label={other.label}
                row={other.row}
                table={data.table}
              />
            )
          }
        />
      </table>
    </div>
  );
}

/** The remainder row, muted, as the per-app tables draw "Other apps". */
function OtherRow({
  label,
  row,
  table,
}: {
  label: string;
  row: CgroupRow;
  table: Table<TableFeatures, CgroupRow>;
}) {
  const remainder = constructRow(
    table,
    REMAINDER_ID,
    { ...row, name: label },
    0,
    0
  );
  return (
    <tr className="h-[29px] border-border border-t text-muted-foreground">
      <DataTableCells
        row={remainder}
        className={cn(CELL, "text-muted-foreground")}
      />
    </tr>
  );
}

function OtherName({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <OtherChip />
      <span className="truncate">{label}</span>
    </span>
  );
}
