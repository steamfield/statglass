/**
 * Sample props for the Overview, CPU, Power and popover widgets. Used by the
 * widget tests and the dev gallery only.
 */
import { FIXTURE_T_END, seededWalk } from "@core/widget-models/fixtures/charts";
import { createElement } from "react";
import type { CoreTilesProps } from "../core-tiles";
import type { LegendProps } from "../legend";
import type { MetricCardProps } from "../metric-card";
import type { ProcessListRow } from "../process-list";
import type { RingGaugeProps } from "../ring-gauge";
import type { RingStatCardProps } from "../ring-stat-card";
import type { StackBarProps } from "../stack-bar";
import type { StatListProps } from "../stat-list";
import { StreamArea } from "../stream-area";
import { residencyLabel, residencySegments } from "./residency";

export {
  BATTERY_STAT_GRID,
  GPU_STAT_GRID,
  INLINE_BAR,
  MEMORY_STACK,
  POPOVER_CPU_ROWS,
  POWER_STACK_BAR,
  POWER_STAT_GRID,
} from "@core/widget-models/fixtures/bars";
export {
  POPOVER_CPU_STREAM,
  POPOVER_GPU_STREAM,
} from "@core/widget-models/fixtures/charts";

function procs(rows: [string, string, string][]): ProcessListRow[] {
  return rows.map(([initial, name, value], i) => ({
    id: `${name}-${i}`,
    initial,
    name,
    value,
  }));
}

function sampleChart(
  accent: MetricCardProps["accent"],
  label: string,
  base: number
) {
  return createElement(StreamArea, {
    accent,
    series: [{ key: accent, values: seededWalk(60, 9, base, 10), step: 1 }],
    tEndMs: FIXTURE_T_END,
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
  {
    accent: "battery",
    title: "Battery",
    value: "87%",
    unit: " on battery",
    chart: sampleChart("battery", "Battery charge", 87),
    stats: [
      { label: "Remaining", value: "6:12" },
      { label: "Health", value: "94%" },
      { label: "Cycles", value: "212" },
      { label: "Battery power", value: "−14.8 W" },
    ],
    href: "/dashboard/battery",
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
