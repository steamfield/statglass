/** Current figures and compact facts for Overview. Null readings remain gaps. */
import { ratio } from "@core/chart-math";
import { scaleOrNull, sumOrNull } from "@core/chart-math/numeric";
import {
  formatBytes,
  formatGhz,
  formatPercent,
  formatRate,
  formatRpm,
  formatTemperature,
  formatWatts,
  MISSING,
  type RateUnits,
  type TemperatureUnits,
} from "@core/format";
import type { LiveProcess, PowerSource } from "@core/generated/bindings";
import { topBy } from "@core/top-by";
import { netTotal } from "~/components/process-table";
import { pressureState } from "~/routes/dashboard/memory/_lib/pressure";
import type { MetricCardProps } from "~/widgets/metric-card";
import type { ProcessListRow } from "~/widgets/process-list";

export type CardBase = Omit<
  MetricCardProps,
  "origin" | "href" | "onOpen" | "chart"
>;

/** Rank live rows, dropping unmeasured values; pid plus start time survives pid reuse. */
export function topProcesses(
  rows: readonly LiveProcess[],
  value: (p: LiveProcess) => number | null,
  format: (v: number) => string,
  n = 5
): ProcessListRow[] {
  return topBy(rows, value, n).map(({ row: p, value: v }) => ({
    id: `${p.pid}:${p.start_time_us}`,
    initial: p.name.slice(0, 1),
    name: p.name,
    value: format(v),
  }));
}

export interface ClusterInput {
  label: string;
  freqHz: number | null;
}

export function cpuCard(input: {
  total: number | null;
  user: number | null;
  system: number | null;
  coreCount: number;
  clusters: [ClusterInput, ClusterInput] | [ClusterInput];
  iowait?: number | null;
  processes: readonly LiveProcess[];
}): CardBase {
  const [first, second] = input.clusters;
  return {
    accent: "cpu",
    title: "CPU",
    value: formatPercent(input.total),
    stats: [
      { label: "User", value: formatPercent(input.user, { decimals: 1 }) },
      { label: "System", value: formatPercent(input.system, { decimals: 1 }) },
      { label: first.label, value: formatGhz(first.freqHz) },
      second
        ? { label: second.label, value: formatGhz(second.freqHz) }
        : {
            label: "I/O wait",
            value: formatPercent(input.iowait ?? null, { decimals: 1 }),
          },
    ],
    list: {
      caption: "Now",
      ariaLabel: "Top processes by CPU",
      rows: topProcesses(
        input.processes,
        (p) =>
          p.cpu_pct === null ? null : p.cpu_pct / Math.max(1, input.coreCount),
        (v) => formatPercent(v, { decimals: 1 })
      ),
    },
  };
}

export function gpuCard(input: {
  util: number | null;
  render: number | null;
  tiler: number | null;
  freqHz: number | null;
  powerW: number | null;
  processes: readonly LiveProcess[] | null;
}): CardBase {
  return {
    accent: "gpu",
    title: "GPU",
    value: formatPercent(input.util),
    stats: [
      { label: "Frequency", value: formatGhz(input.freqHz) },
      { label: "Power", value: formatWatts(input.powerW) },
      { label: "Render", value: formatPercent(input.render) },
      { label: "Tiler", value: formatPercent(input.tiler) },
    ],
    ...(input.processes === null
      ? {}
      : {
          list: {
            caption: "Now",
            ariaLabel: "Top processes by GPU",
            rows: topProcesses(
              input.processes,
              (p) => (p.gpu_pct === null || p.gpu_pct <= 0 ? null : p.gpu_pct),
              (v) => formatPercent(v, { decimals: 1 })
            ),
            note: input.processes.some((p) => p.gpu_pct !== null)
              ? "Your processes only"
              : "Measuring GPU by process…",
          },
        }),
  };
}

export function memoryCard(input: {
  used: number | null;
  app: number | null;
  wired: number | null;
  compressed: number | null;
  pressureLevel: number | null;
  swapUsed: number | null;
  binary: boolean;
  processes: readonly LiveProcess[];
}): CardBase {
  const units = input.binary ? "GiB" : "GB";
  const state = pressureState(input.pressureLevel);
  return {
    accent: "mem",
    title: "Memory",
    ...((state === "warn" || state === "critical") && {
      alert: { tone: state, text: `Pressure ${state}` },
    }),
    value: formatBytes(input.used, { units, decimals: 1 }),
    stats: [
      {
        label: "Pressure",
        value: state ?? MISSING,
      },
      { label: "Swap", value: formatBytes(input.swapUsed, { units }) },
      { label: "App", value: formatBytes(input.app, { units, decimals: 1 }) },
      {
        label: "Wired + comp.",
        value: formatBytes(sumOrNull(input.wired, input.compressed), {
          units,
          decimals: 1,
        }),
      },
    ],
    list: {
      caption: "Now",
      ariaLabel: "Top processes by memory",
      rows: topProcesses(
        input.processes,
        (p) => p.mem_bytes,
        (v) => formatBytes(v, { units })
      ),
    },
  };
}

export function powerCard(input: {
  system: number | null;
  cpu: number | null;
  gpu: number | null;
  dram: number | null;
  hottestC: number | null;
  fanRpm: number | null;
  passive: boolean;
  powerSource: PowerSource | null;
  temperature: TemperatureUnits;
  processes: readonly LiveProcess[];
}): CardBase {
  return {
    accent: "power",
    title: "Power & Sensors",
    value: formatWatts(input.system),
    ...(input.powerSource === null
      ? {}
      : {
          unit: input.powerSource === "battery" ? " on battery" : " on adapter",
        }),
    stats: [
      {
        label: "Hottest zone",
        value: formatTemperature(input.hottestC, { units: input.temperature }),
      },
      {
        label: "Fans",
        value: input.passive ? "Passive cooling" : formatRpm(input.fanRpm),
      },
      { label: "CPU", value: formatWatts(input.cpu) },
      {
        label: "GPU + DRAM",
        value: formatWatts(sumOrNull(input.gpu, input.dram)),
      },
    ],
    list: {
      caption: "Now",
      ariaLabel: "Top processes by energy impact",
      rows: topProcesses(
        input.processes,
        (p) => p.energy,
        (v) => `${v.toFixed(1)} EI`
      ),
    },
  };
}

export interface IfaceRate {
  iface: string;
  rx: number | null;
  tx: number | null;
}

export function networkCard(input: {
  primary: IfaceRate | null;
  linkBps: number | null;
  total: { rx: number | null; tx: number | null };
  interfaces: readonly IfaceRate[];
  rate: RateUnits;
  processes: readonly LiveProcess[] | null;
}): CardBase {
  const fraction = ratio(
    scaleOrNull(input.primary?.rx ?? null, 8),
    input.linkBps
  );
  return {
    accent: "net",
    title: "Network",
    // Upload first, as the chart draws it above the axis.
    value: `↑ ${formatRate(input.total.tx, { units: input.rate })} ↓ ${formatRate(input.total.rx, { units: input.rate })}`,
    stats: [
      { label: "Of link", value: formatPercent(scaleOrNull(fraction, 100)) },
      { label: "Interface", value: input.primary?.iface ?? MISSING },
    ],
    list:
      input.processes === null
        ? {
            caption: "Now",
            ariaLabel: "Interfaces by total rate",
            rows: topBy(input.interfaces, (i) => sumOrNull(i.rx, i.tx), 5).map(
              ({ row: i, value: v }) => ({
                id: i.iface,
                initial: i.iface.slice(0, 1),
                name: i.iface,
                value: formatRate(v, { units: input.rate }),
              })
            ),
          }
        : {
            caption: "Now",
            ariaLabel: "Top processes by network rate",
            note: "Your processes only",
            rows: topProcesses(
              input.processes,
              (p) => {
                const total = netTotal(p);
                return total === null || total <= 0 ? null : total;
              },
              (v) => formatRate(v, { units: input.rate })
            ),
          },
  };
}

export function diskCard(input: {
  read: number | null;
  write: number | null;
  totalBytes: number | null;
  usedBytes: number | null;
  bytes: "GB" | "GiB";
  rate: RateUnits;
  processes: readonly LiveProcess[];
}): CardBase {
  return {
    accent: "disk",
    title: "Disk",
    // Read first and up, write down, as the chart draws them.
    value: `↑ ${formatRate(input.read, { units: input.rate })} ↓ ${formatRate(input.write, { units: input.rate })}`,
    stats: [
      {
        label: "Used",
        value: `${formatBytes(input.usedBytes, { units: input.bytes })} of ${formatBytes(input.totalBytes, { units: input.bytes })}`,
      },
    ],
    list: {
      caption: "Now",
      ariaLabel: "Top processes by disk I/O",
      rows: topProcesses(
        input.processes,
        (p) =>
          p.disk_read_bps === null && p.disk_write_bps === null
            ? null
            : (p.disk_read_bps ?? 0) + (p.disk_write_bps ?? 0),
        (v) => formatRate(v, { units: input.rate })
      ),
    },
  };
}

/** "10P + 4E" from cluster kinds and core counts. */
export function coresLabel(
  topology: readonly { kind: string; cores: readonly string[] }[]
): string {
  const count = (kind: string) =>
    topology
      .filter((c) => c.kind === kind)
      .reduce((n, c) => n + c.cores.length, 0);
  const p = count("performance");
  const e = count("efficiency");
  if (p === 0 && e === 0) return "";
  return [p ? `${p}P` : null, e ? `${e}E` : null].filter(Boolean).join(" + ");
}
