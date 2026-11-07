/**
 * Sample props for the Overview, CPU, Power and popover widgets. Used by the
 * widget tests and the dev gallery only.
 */
import { createElement } from "react";
import type { CoreTilesProps } from "../core-tiles";
import type { InlineBarProps } from "../inline-bar";
import type { LegendProps } from "../legend";
import type { MetricCardProps } from "../metric-card";
import type { ProcessListRow } from "../process-list";
import type { RingGaugeProps } from "../ring-gauge";
import type { RingStatCardProps } from "../ring-stat-card";
import type { StackBarProps } from "../stack-bar";
import type { StatListProps } from "../stat-list";
import { StreamArea } from "../stream-area";
import { residencyLabel, residencySegments } from "./residency";

function procs(rows: [string, string, string][]): ProcessListRow[] {
  return rows.map(([initial, name, value], i) => ({
    id: `${name}-${i}`,
    initial,
    name,
    value,
  }));
}

/** Seeded walk: 60 values around `base`. */
function walk(n: number, seed: number, base: number, noise: number) {
  let s = seed;
  const r = () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
  let v = base;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    v += (r() - 0.5) * noise;
    v += (base - v) * 0.2;
    out.push(Math.round(Math.max(1, v) * 10) / 10);
  }
  return out;
}

const T_END = 1_759_617_600_000; // Sun Oct 4 2026 22:40 UTC-ish; any fixed ms epoch

function sampleChart(
  accent: MetricCardProps["accent"],
  label: string,
  base: number
) {
  return createElement(StreamArea, {
    accent,
    series: [{ key: accent, values: walk(60, 9, base, 10), step: 1 }],
    tEndMs: T_END,
    intervalMs: 5000,
    height: 88,
    yMax: 100,
    ariaLabel: `${label}, last 5 minutes`,
    xTicks: ["5m", "2m", "now"],
  });
}

const CPU_CARD: MetricCardProps = {
  accent: "cpu",
  title: "CPU",
  value: "18%",
  chart: sampleChart("cpu", "CPU total and system", 18),
  stats: [
    { label: "User", value: "12.4%" },
    { label: "System", value: "5.6%" },
    { label: "P GHz", value: "3.2 GHz" },
    { label: "E GHz", value: "1.0 GHz" },
  ],
  list: {
    caption: "Now",
    ariaLabel: "Top processes by CPU",
    rows: procs([
      ["X", "Xcode", "6.2%"],
      ["k", "kernel_task", "3.1%"],
      ["W", "WindowServer", "2.4%"],
      ["S", "Safari", "1.8%"],
      ["n", "node", "1.1%"],
    ]),
  },
  href: "/dashboard/cpu",
};
const POWER_CARD: MetricCardProps = {
  accent: "power",
  title: "Power & Sensors",
  value: "14.8 W",
  unit: " on battery",
  chart: sampleChart("power", "System power", 15),
  stats: [
    { label: "Hottest zone", value: "61 °C" },
    { label: "Fans", value: "1,850 RPM" },
    { label: "CPU", value: "6.4 W" },
    { label: "GPU + DRAM", value: "4.0 W" },
  ],
  list: {
    caption: "Now",
    ariaLabel: "Top processes by energy impact",
    rows: procs([
      ["X", "Xcode", "412 EI"],
      ["k", "kernel_task", "188 EI"],
      ["S", "Safari", "96 EI"],
      ["F", "Figma", "74 EI"],
      ["W", "WindowServer", "61 EI"],
    ]),
  },
  href: "/dashboard/power",
};
export const OVERVIEW_CARDS: MetricCardProps[] = [
  CPU_CARD,
  {
    accent: "gpu",
    title: "GPU",
    value: "36%",
    chart: sampleChart("gpu", "GPU utilization", 36),
    stats: [
      { label: "Frequency", value: "1.1 GHz" },
      { label: "Power", value: "3.1 W" },
      { label: "Render", value: "28%" },
      { label: "Tiler", value: "8%" },
    ],
    href: "/dashboard/gpu",
  },
  {
    accent: "mem",
    title: "Memory",
    value: "17.6 GB",
    chart: sampleChart("mem", "Memory pressure", 42),
    stats: [
      { label: "Pressure", value: "normal" },
      { label: "Swap", value: "512 MB" },
      { label: "App", value: "11.6 GB" },
      { label: "Wired + comp.", value: "6.0 GB" },
    ],
    list: {
      caption: "Now",
      ariaLabel: "Top processes by memory",
      rows: procs([
        ["X", "Xcode", "3.8 GB"],
        ["D", "Docker", "2.6 GB"],
        ["S", "Safari", "1.9 GB"],
        ["F", "Figma", "1.2 GB"],
        ["n", "node", "840 MB"],
      ]),
    },
    href: "/dashboard/memory",
  },
  POWER_CARD,
  {
    accent: "net",
    title: "Network",
    value: "↓ 38.4 MB/s ↑ 1.2 MB/s",
    chart: sampleChart("net", "Network", 38),
    stats: [
      { label: "Of link", value: "26%" },
      { label: "Interface", value: "en0" },
    ],
    list: {
      caption: "Now",
      ariaLabel: "Interfaces by total rate",
      rows: procs([
        ["e", "en0", "39.6 MB/s"],
        ["u", "utun4", "1.1 MB/s"],
      ]),
    },
    href: "/dashboard/network",
  },
  {
    accent: "disk",
    title: "Disk",
    value: "↓ 220 MB/s ↑ 48 MB/s",
    chart: sampleChart("disk", "Disk I/O", 22),
    stats: [{ label: "Used", value: "388 GB of 1.0 TB" }],
    list: {
      caption: "Now",
      ariaLabel: "Top processes by disk I/O",
      rows: procs([
        ["X", "Xcode", "142 MB/s"],
        ["D", "Docker", "51 MB/s"],
        ["m", "mds_stores", "18 MB/s"],
        ["S", "Safari", "6 MB/s"],
        ["n", "node", "3 MB/s"],
      ]),
    },
    href: "/dashboard/disk",
  },
];

export const PASSIVE_COOLING_CARD: MetricCardProps = {
  ...POWER_CARD,
  unit: " on adapter",
  stats: [
    { label: "Hottest zone", value: "61 °C" },
    { label: "Fans", value: "Passive cooling" },
    { label: "CPU", value: "6.4 W" },
    { label: "GPU + DRAM", value: "4.0 W" },
  ],
};

export const RING_GAUGE: RingGaugeProps = {
  fractions: [0.124, 0.056],
  value: "18%",
  label: "Load",
  accent: "cpu",
  size: 88,
};

export const INLINE_BAR: InlineBarProps = {
  label: "P-cluster",
  value: "3.2 GHz",
  fraction: 0.71,
  accent: "cpu",
};

export const POPOVER_CPU_ROWS: InlineBarProps[] = [
  { label: "User", value: "12.4%", fraction: 0.124, layout: "row" },
  {
    label: "System",
    value: "5.6%",
    fraction: 0.056,
    layout: "row",
    rampStep: 2,
  },
];

export const POPOVER_CPU_STREAM = {
  series: [{ key: "cpu.total", values: walk(60, 5, 18, 9), step: 1 as const }],
  tEndMs: T_END,
  intervalMs: 1000,
  yMax: 40,
  accent: "cpu" as const,
  height: 52,
  ariaLabel: "CPU, last 60 seconds, 18%",
  ceilingLabel: "40%",
  windowLabel: "60s",
  gridlines: [20],
};

export const POPOVER_GPU_STREAM = {
  series: [{ key: "gpu.util", values: walk(60, 9, 36, 10), step: 1 as const }],
  tEndMs: T_END,
  intervalMs: 1000,
  yMax: 80,
  accent: "gpu" as const,
  height: 40,
  ariaLabel: "GPU, last 60 seconds, 36%",
};

export const LEGEND: LegendProps = {
  items: [
    { label: "User", value: "12.4%", step: 1 },
    { label: "System", value: "5.6%", step: 2 },
  ],
  accent: "cpu",
};

export const CORE_TILES: CoreTilesProps = {
  clusters: [
    {
      id: "P0",
      name: "P-cluster",
      freq: "3.2 GHz",
      cores: [34, 22, 41, 18, 12, 9, 27, 15, 8, 6].map((load, i) => ({
        id: `P${i}`,
        load,
      })),
    },
    {
      id: "E0",
      name: "E-cluster",
      freq: "1.0 GHz",
      cores: [52, 38, 44, 29].map((load, i) => ({ id: `E${i}`, load })),
    },
  ],
};

/**
 * The second segment is "App", not "Active", so the numbers
 * reconcile with the Overview (v1-local-monitor.md 4.3).
 */
export const MEMORY_STACK: StackBarProps = {
  accent: "mem",
  showLegend: true,
  segments: [
    {
      key: "wired",
      label: "Wired",
      value: "3.9 GB",
      fraction: 3.9 / 24,
      step: 1,
    },
    {
      key: "app",
      label: "App",
      value: "11.6 GB",
      fraction: 11.6 / 24,
      step: 2,
    },
    {
      key: "compressed",
      label: "Compressed",
      value: "2.1 GB",
      fraction: 2.1 / 24,
      step: "hatch",
    },
    {
      key: "cached",
      label: "Cached files",
      value: "4.0 GB",
      fraction: 4 / 24,
      step: 4,
    },
    {
      key: "free",
      label: "Free",
      value: "2.4 GB",
      fraction: 2.4 / 24,
      step: "track",
    },
  ],
  extraLegend: [{ label: "Swap", value: "512 MB" }],
};

export const POWER_STACK_BAR: StackBarProps = {
  accent: "power",
  segments: [
    { key: "cpu", label: "CPU", value: "6.4 W", fraction: 6.4 / 14.8, step: 1 },
    { key: "gpu", label: "GPU", value: "3.1 W", fraction: 3.1 / 14.8, step: 2 },
    { key: "ane", label: "ANE", value: "0.0 W", fraction: 0, step: "hatch" },
    {
      key: "dram",
      label: "DRAM",
      value: "0.9 W",
      fraction: 0.9 / 14.8,
      step: 3,
    },
    {
      key: "rest",
      label: "Rest of system",
      value: "4.4 W",
      fraction: 4.4 / 14.8,
      step: "track",
    },
  ],
};

export const POWER_STAT_GRID: StatListProps = {
  layout: "grid",
  accent: "power",
  items: [
    { label: "CPU", value: "6.4 W", swatch: 1 },
    { label: "GPU", value: "3.1 W", swatch: 2 },
    { label: "ANE", value: "0.0 W", swatch: "hatch", muted: true },
    { label: "DRAM", value: "0.9 W", swatch: 3 },
  ],
};

export const GPU_STAT_GRID: StatListProps = {
  layout: "grid",
  items: [
    { label: "Freq", value: "1.1 GHz" },
    { label: "Power", value: "3.1 W" },
    { label: "Cores", value: "20" },
  ],
};

export const BATTERY_STAT_GRID: StatListProps = {
  layout: "grid",
  items: [
    { label: "Remaining", value: "6:12" },
    { label: "Health", value: "94%" },
    { label: "Cycles", value: "212" },
  ],
};

export const CPU_STAT_STRIP: StatListProps = {
  accent: "cpu",
  hero: { label: "Total", value: "18%" },
  items: [
    { label: "User", value: "12.4%", swatch: 1 },
    { label: "System", value: "5.6%", swatch: 2 },
    { label: "Idle", value: "82.0%", muted: true },
    { label: "Load avg", value: "3.42", secondary: "2.98 2.71" },
  ],
};

export const BATTERY_STAT_STRIP: StatListProps = {
  items: [
    { label: "Charge", value: "87%" },
    { label: "Health", value: "94%" },
    { label: "Cycles", value: "212" },
    { label: "Remaining", value: "6:12" },
    { label: "Full charge", value: "68.2", unit: "of 72.6 Wh" },
  ],
};

export const RING_STAT_CARDS: RingStatCardProps[] = [
  {
    accent: "power",
    origin: "tl",
    title: "CPU",
    description: "Max of SMC CPU group",
    ring: { fractions: [61 / 105], value: "61", label: "°C", accent: "temp" },
    kv: { label: "P-cluster", value: "3.2 GHz" },
  },
  {
    accent: "power",
    origin: "tr",
    title: "GPU",
    description: "Max of SMC GPU group",
    ring: { fractions: [54 / 105], value: "54", label: "°C", accent: "temp" },
    kv: { label: "Frequency", value: "1.1 GHz" },
  },
  {
    accent: "power",
    origin: "bl",
    title: "Fans",
    description: "Left 1,840 · right 1,860",
    ring: {
      fractions: [1850 / 5700],
      value: "1,850",
      label: "RPM",
      accent: "power",
    },
    kv: { label: "Mode", value: "Automatic" },
  },
  {
    accent: "power",
    origin: "br",
    title: "System",
    description: "Drawn from battery",
    ring: {
      fractions: [14.8 / 40],
      value: "14.8",
      label: "W",
      accent: "power",
    },
    kv: { label: "Package", value: "10.4 W" },
  },
];

export const PASSIVE_FANS_CARD: RingStatCardProps = {
  accent: "power",
  origin: "bl",
  title: "Fans",
  description: "Passive cooling",
  ring: null,
  kv: { label: "Mode", value: "No fans" },
};

const GPU_RESIDENCY = [
  { label: "1.40 GHz", pct: 4 },
  { label: "1.13 GHz", pct: 9 },
  { label: "0.86 GHz", pct: 18 },
  { label: "0.44 GHz", pct: 10 },
  { label: "idle", pct: 59 },
];

/** GPU frequency residency over the chart window (Frequency card). */
export const RESIDENCY: StackBarProps = {
  segments: residencySegments(GPU_RESIDENCY),
  accent: "gpu",
  showLegend: true,
  legendColumns: 1,
  ariaLabel: residencyLabel("last 15 minutes residency", GPU_RESIDENCY),
};
