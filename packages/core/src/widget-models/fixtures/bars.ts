/**
 * Bar and stat fixtures both apps render and the bar models are tested
 * against: the popover's inline bars, memory and power stacks and stat
 * grids. The desktop gallery and widget tests reach them through
 * `src/app/widgets/lib/sample-props.ts`.
 */
import type { InlineBarData } from "@core/widget-models/inline-bar";
import type { StackBarData } from "@core/widget-models/stack-bar";
import type { StatListData } from "@core/widget-models/stat-list";

export const INLINE_BAR: InlineBarData = {
  label: "P-cluster",
  value: "3.2 GHz",
  fraction: 0.71,
  accent: "cpu",
};

export const POPOVER_CPU_ROWS: InlineBarData[] = [
  { label: "User", value: "12.4%", fraction: 0.124, layout: "row" },
  {
    label: "System",
    value: "5.6%",
    fraction: 0.056,
    layout: "row",
    rampStep: 2,
  },
];

/**
 * The second segment is "App", not "Active", so the numbers
 * reconcile with the Overview (v1-local-monitor.md 4.3).
 */
export const MEMORY_STACK: StackBarData = {
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

export const POWER_STACK_BAR: StackBarData = {
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

export const POWER_STAT_GRID: StatListData = {
  layout: "grid",
  accent: "power",
  items: [
    { label: "CPU", value: "6.4 W", swatch: 1 },
    { label: "GPU", value: "3.1 W", swatch: 2 },
    { label: "ANE", value: "0.0 W", swatch: "hatch", muted: true },
    { label: "DRAM", value: "0.9 W", swatch: 3 },
  ],
};

export const GPU_STAT_GRID: StatListData = {
  layout: "grid",
  items: [
    { label: "Freq", value: "1.1 GHz" },
    { label: "Power", value: "3.1 W" },
    { label: "Cores", value: "20" },
  ],
};

export const BATTERY_STAT_GRID: StatListData = {
  layout: "grid",
  items: [
    { label: "Remaining", value: "6:12" },
    { label: "Health", value: "94%" },
    { label: "Cycles", value: "212" },
  ],
};
