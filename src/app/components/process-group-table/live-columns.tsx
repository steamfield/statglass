/**
 * The live process columns (`ProcessColumn`) as grouped-table columns over
 * `LiveGroup` and `LiveProcess`. A group's cells read its summed figures
 * (`LiveGroup.figures`) and a member's read the process itself; both share
 * field names, so each figure column is defined once over `LiveFigures`.
 */
import { ratio } from "@core/chart-math";
import {
  type ByteUnits,
  fixed,
  formatBytes,
  formatRate,
  MISSING,
  type RateUnits,
} from "@core/format";
import type { LiveProcess } from "@core/generated/bindings";
import {
  diskTotal,
  type LiveFigures,
  type LiveGroup,
  netTotal,
} from "@core/process-groups";
import type { ReactNode } from "react";
import { type ColumnSort, MeterCell } from "~/components/data-table";
import { cn } from "~/lib/utils";
import type { GroupColumn, SortValue } from "./types";

/** Every column the live process tables can show; `name` is the table's own. */
export type ProcessColumn =
  | "name"
  | "pid"
  | "port"
  | "cpu"
  | "mem"
  | "compressed"
  | "threads"
  | "wakeups"
  | "energy"
  | "diskRead"
  | "diskWrite"
  | "diskTotal"
  | "netRx"
  | "netTx"
  | "netTotal"
  | "gpu"
  | "user";

/** A live table's sort, in the process column vocabulary. */
export type ProcessSort = ColumnSort<ProcessColumn>;

/** What a cell reads besides its row. */
export interface LiveColumnContext {
  /** % CPU that fills the inline bar. The CPU page scales to 140%. */
  cpuBarMaxPct: number;
  memUnits: ByteUnits;
  rateUnits: RateUnits;
}

type LiveColumn = GroupColumn<LiveGroup, LiveProcess>;

/** Ports listed in a cell before the rest collapse to "+N". */
const PORTS_SHOWN = 3;

/**
 * "3000, 5173", or "5432, 6379, 8080 +4" past three. Blank for a process
 * listening on none, which is most rows; a dash only when ports were not read.
 */
function portsText(ports: readonly number[] | null): string {
  if (ports == null) return MISSING;
  const head = ports.slice(0, PORTS_SHOWN).join(", ");
  const rest = ports.length - PORTS_SHOWN;
  return rest > 0 ? `${head} +${rest}` : head;
}

const grouped = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function num(v: number | null, decimals = 0): string {
  if (v == null || !Number.isFinite(v)) return MISSING;
  return decimals === 0 ? grouped.format(v) : fixed(v, decimals);
}

const figure = (text: string, className?: string) => (
  <span className={cn("figures", className)}>{text}</span>
);

const count = (v: number | null) => figure(num(v));

/** A bar out of `max` beside the figure, filled with `fill`. */
const meter = (fill: string, max: number) => (v: number | null) => (
  <MeterCell fraction={ratio(v, max)} fill={fill} className="text-foreground">
    {num(v, 1)}
  </MeterCell>
);

/** A right-aligned column whose group and member cells read the same fields. */
function figureColumn(
  id: ProcessColumn,
  header: string,
  value: (f: LiveFigures) => SortValue,
  cell: (f: LiveFigures) => ReactNode
): LiveColumn {
  return {
    id,
    header,
    align: "right",
    groupValue: (g) => value(g.figures),
    memberValue: (p) => value(p),
    group: (g) => cell(g.figures),
    member: (p) => cell(p),
  };
}

/** The figure fields that hold a number, or a missing one. */
type NumberField = Exclude<keyof LiveFigures, "ports" | "user">;

/** A column showing one numeric field of a group's figures or a process. */
function fieldColumn(
  id: ProcessColumn,
  header: string,
  field: NumberField,
  show: (v: number | null) => ReactNode
): LiveColumn {
  return figureColumn(
    id,
    header,
    (f) => f[field],
    (f) => show(f[field])
  );
}

/** A member's PID; a group shows one only when it is a single process. */
const PID: LiveColumn = {
  id: "pid",
  header: "PID",
  align: "right",
  groupValue: (g) => soleMember(g)?.pid ?? null,
  memberValue: (p) => p.pid,
  group: (g) =>
    figure(String(soleMember(g)?.pid ?? ""), "text-muted-foreground"),
  member: (p) => figure(String(p.pid), "text-muted-foreground"),
};

function soleMember(g: LiveGroup): LiveProcess | undefined {
  return g.members.length === 1 ? g.members[0] : undefined;
}

/** Sorted by the lowest port; a process listening on none sorts with the unread. */
const PORT = figureColumn(
  "port",
  "Port",
  (f) => f.ports?.[0] ?? null,
  (f) => (
    <span
      className="figures text-muted-foreground"
      title={
        f.ports && f.ports.length > PORTS_SHOWN ? f.ports.join(", ") : undefined
      }
    >
      {portsText(f.ports)}
    </span>
  )
);

/** A group's user is blank unless every member runs as the same one. */
const USER: LiveColumn = {
  id: "user",
  header: "User",
  align: "left",
  groupValue: (g) => g.figures.user,
  memberValue: (p) => p.user,
  group: (g) => figure(g.figures.user ?? "", "text-muted-foreground"),
  member: (p) => figure(p.user, "text-muted-foreground"),
};

/** CPU, GPU, memory, threads, wake-ups and energy. */
function loadColumns(ctx: LiveColumnContext) {
  const bytes = (v: number | null) =>
    figure(formatBytes(v, { units: ctx.memUnits }));
  const cpuMeter = meter("var(--color-cpu)", ctx.cpuBarMaxPct);
  // Percent of the whole GPU (D-085), so the bar is out of 100.
  const gpuMeter = meter("var(--color-gpu)", 100);
  return {
    cpu: fieldColumn("cpu", "% CPU", "cpu_pct", cpuMeter),
    gpu: fieldColumn("gpu", "% GPU", "gpu_pct", gpuMeter),
    mem: fieldColumn("mem", "Memory", "mem_bytes", bytes),
    compressed: fieldColumn(
      "compressed",
      "Compressed",
      "compressed_bytes",
      bytes
    ),
    threads: fieldColumn("threads", "Threads", "threads", count),
    wakeups: fieldColumn(
      "wakeups",
      "Idle wake-ups",
      "idle_wakeups_per_s",
      count
    ),
    energy: fieldColumn("energy", "Energy", "energy", (v) => figure(num(v, 1))),
  };
}

/** Disk and network rates; the totals read brighter. */
function rateColumns(ctx: LiveColumnContext) {
  const rate = (v: number | null) =>
    figure(formatRate(v, { units: ctx.rateUnits }));
  const total = (v: number | null) =>
    figure(formatRate(v, { units: ctx.rateUnits }), "text-foreground");
  return {
    diskRead: fieldColumn("diskRead", "Disk read", "disk_read_bps", rate),
    diskWrite: fieldColumn("diskWrite", "Disk write", "disk_write_bps", rate),
    diskTotal: figureColumn("diskTotal", "Disk total", diskTotal, (f) =>
      total(diskTotal(f))
    ),
    netRx: fieldColumn("netRx", "Down", "net_rx_bps", rate),
    netTx: fieldColumn("netTx", "Up", "net_tx_bps", rate),
    netTotal: figureColumn("netTotal", "Net total", netTotal, (f) =>
      total(netTotal(f))
    ),
  };
}

/**
 * The grouped-table columns for `ids`, in order. `name` is skipped: the
 * table draws the name column itself.
 */
export function liveColumns(
  ids: readonly ProcessColumn[],
  ctx: LiveColumnContext
): LiveColumn[] {
  const byId: Record<Exclude<ProcessColumn, "name">, LiveColumn> = {
    pid: PID,
    port: PORT,
    user: USER,
    ...loadColumns(ctx),
    ...rateColumns(ctx),
  };
  return ids.flatMap((id) => (id === "name" ? [] : [byId[id]]));
}
