import { stackSum } from "@core/chart-math";
import { formatBytes, formatPercent, formatWatts } from "@core/format";
import type { Module } from "@core/generated/bindings";
import type { LiveMirrorChartProps } from "~/components/live-mirror-chart";
import type { RangeTotal } from "~/components/range-totals-strip";
import type { StreamAreaProps } from "~/widgets/stream-area";
import { BYTES_GUTTER, type ModuleYAxis } from "./module-history-chart";

/** Shared drawing contract for a module's lead area chart. Callers own subscriptions. */
export interface HeroChartSpec {
  module: Module;
  keys: readonly string[];
  subject: string;
  lines(values: Record<string, (number | null)[]>): StreamAreaProps["series"];
  yAxis: ModuleYAxis;
  totals?: readonly RangeTotal[];
}

export const CPU_HERO = {
  module: "cpu",
  keys: ["cpu.total", "cpu.system"],
  subject: "CPU total and system",
  lines: (values) => [
    { key: "cpu.total", values: values["cpu.total"] ?? [], step: 1 },
    { key: "cpu.system", values: values["cpu.system"] ?? [], step: 2 },
  ],
  yAxis: "percent",
  totals: [
    {
      metric: "cpu.total",
      label: "Avg",
      format: (s) => formatPercent(s.avg, { decimals: 1 }),
    },
    { metric: "cpu.total", label: "Peak", format: (s) => formatPercent(s.max) },
  ],
} satisfies HeroChartSpec;

export const GPU_HERO = {
  module: "gpu",
  keys: ["gpu.util"],
  subject: "GPU utilization",
  lines: (values) => [
    { key: "gpu.util", values: values["gpu.util"] ?? [], step: 1 },
  ],
  yAxis: "percent",
  totals: [
    {
      metric: "gpu.util",
      label: "Avg",
      format: (s) => formatPercent(s.avg, { decimals: 1 }),
    },
    { metric: "gpu.util", label: "Peak", format: (s) => formatPercent(s.max) },
  ],
} satisfies HeroChartSpec;

export const MEMORY_PRESSURE_HERO = {
  module: "memory",
  keys: ["mem.pressure"],
  subject: "Memory pressure",
  lines: (values) => [
    { key: "mem.pressure", values: values["mem.pressure"] ?? [], step: 1 },
  ],
  yAxis: "percent",
} satisfies HeroChartSpec;

/** Right-align the stack; a slot missing either part stays a gap. */
function stackOnto(
  base: readonly (number | null)[],
  top: readonly (number | null)[]
): (number | null)[] {
  const n = Math.min(base.length, top.length);
  const b = base.length - n;
  const t = top.length - n;
  return Array.from({ length: n }, (_, i) =>
    stackSum([base[b + i], top[t + i]])
  );
}

const MEMORY_USED_KEYS = ["mem.used", "mem.cached"];
export function memoryUsedHero(
  totalBytes: number,
  format: (value: number) => string
): HeroChartSpec {
  return {
    module: "memory",
    keys: MEMORY_USED_KEYS,
    subject: "Memory used and cached files",
    lines: (values) => {
      const used = values["mem.used"] ?? [];
      return [
        {
          key: "mem.cached",
          values: stackOnto(used, values["mem.cached"] ?? []),
          step: 4,
        },
        { key: "mem.used", values: used, step: 1 },
      ];
    },
    yAxis: { ceiling: totalBytes, format, gutter: BYTES_GUTTER },
  };
}

export const POWER_HERO = {
  module: "power",
  keys: ["power.system"],
  subject: "System power",
  lines: (values) => [
    {
      key: "power.system",
      values: values["power.system"] ?? [],
      step: 1,
      weight: 2,
    },
  ],
  yAxis: { ceiling: "auto", min: 5, format: (w) => `${w}W` },
  totals: [
    { metric: "power.system", label: "Avg", format: (s) => formatWatts(s.avg) },
    {
      metric: "power.system",
      label: "Peak",
      format: (s) => formatWatts(s.max),
    },
  ],
} satisfies HeroChartSpec;

export const NETWORK_HERO = {
  upKey: "net.tx_total",
  downKey: "net.rx_total",
  upLabel: "Upload",
  downLabel: "Download",
  subject: "Network",
  minCeiling: 100_000,
  totals: [
    {
      metric: "net.rx_total",
      label: "↓ Downloaded",
      format: (s) => formatBytes(s.integral),
    },
    {
      metric: "net.tx_total",
      label: "↑ Uploaded",
      format: (s) => formatBytes(s.integral),
    },
  ],
} satisfies Pick<
  LiveMirrorChartProps,
  "upKey" | "downKey" | "upLabel" | "downLabel" | "subject" | "minCeiling"
> & { totals: readonly RangeTotal[] };
