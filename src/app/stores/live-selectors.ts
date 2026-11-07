/**
 * Per-module selectors over a host's live state. Each returns a flat object
 * of primitives so `useShallow` can compare it: a frame that only moves CPU
 * values leaves the Memory selector's result shallow-equal, and the Memory
 * card does not re-render (the render-count test pins this).
 *
 * Values are raw units from the catalog (percent, Hz, bytes, bytes/s, W,
 * °C). `null` means no current value: a gap or a missing series, never 0.
 */
import type { PowerSource } from "@core/generated/bindings";
import {
  type HostLive,
  type LayoutInfo,
  type SeriesWindow,
  seriesWindow,
} from "@core/live-state";
import { keyByLabel, parseLabels, sk } from "@core/series-key";
import { useShallow } from "zustand/react/shallow";
import { type HostLiveState, useHost, useHostStore } from "./host-store";

type S = HostLiveState;

/** The current value of series `key` (display form); null is a gap. */
export const held = (s: HostLive, key: string): number | null =>
  s.held[key] ?? null;

/** The current layout; null before the first one. */
export const currentLayout = (s: HostLive): LayoutInfo | null =>
  s.layoutNo === null ? null : (s.layouts[s.layoutNo] ?? null);

/** Keys of `metric` in the current layout. */
export function keysOf(s: HostLive, metric: string): readonly string[] {
  return currentLayout(s)?.byMetric.get(metric) ?? [];
}

/** Max over every label set of `metric`; null when none has a value. */
function max(s: S, metric: string): number | null {
  let out: number | null = null;
  for (const k of keysOf(s, metric)) {
    const v = held(s, k);
    if (v !== null && (out === null || v > out)) out = v;
  }
  return out;
}

/** `{ labelValue: value }` for label `name` of `metric`. */
function byLabel(
  s: S,
  metric: string,
  name: string
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const k of keysOf(s, metric)) {
    const v = parseLabels(k)[name];
    if (v !== undefined) out[v] = held(s, k);
  }
  return out;
}

/** `cpu.cluster.freq` of cluster `name`. */
export const clusterFreqKey = keyByLabel("cpu.cluster.freq", "cluster");
const P0_FREQ = clusterFreqKey("P0");
const E0_FREQ = clusterFreqKey("E0");
const PSI_SOME = sk("mem.psi", { stall: "some" });
const volTotal = keyByLabel("disk.total", "vol");
const volFree = keyByLabel("disk.free", "vol");
const volUsed = keyByLabel("disk.used", "vol");

export const selectCpu = (s: S) => ({
  total: held(s, "cpu.total"),
  user: held(s, "cpu.user"),
  system: held(s, "cpu.system"),
  /** Linux only (D-116): time idle with I/O outstanding. */
  iowait: held(s, "cpu.iowait"),
  pFreqHz: held(s, P0_FREQ),
  eFreqHz: held(s, E0_FREQ),
});

/** Per-core load keyed by core label ("P0", "E3"). */
export const selectCpuCores = (s: S) => byLabel(s, "cpu.load", "core");

export const selectGpu = (s: S) => ({
  util: held(s, "gpu.util"),
  render: held(s, "gpu.render"),
  tiler: held(s, "gpu.tiler"),
  freqHz: held(s, "gpu.freq"),
  powerW: held(s, "power.gpu"),
});

export const selectMemory = (s: S) => ({
  used: held(s, "mem.used"),
  app: held(s, "mem.app"),
  wired: held(s, "mem.wired"),
  compressed: held(s, "mem.compressed"),
  cached: held(s, "mem.cached"),
  free: held(s, "mem.free"),
  pressure: held(s, "mem.pressure"),
  pressureLevel: held(s, "mem.pressure_level"),
  swapUsed: held(s, "mem.swap_used"),
  /** Linux PSI (D-116): share of time some task stalled on memory. */
  psiSome: held(s, PSI_SOME),
  /**
   * The layout has the macOS composition (`mem.app`); a Linux agent has
   * only used, cached and free (D-116).
   */
  composition: keysOf(s, "mem.app").length > 0,
  /** The layout has macOS memory pressure; a Linux agent reports PSI instead. */
  hasPressure: keysOf(s, "mem.pressure").length > 0,
});

export const selectPower = (s: S) => ({
  system: held(s, "power.system"),
  cpu: held(s, "power.cpu"),
  gpu: held(s, "power.gpu"),
  ane: held(s, "power.ane"),
  dram: held(s, "power.dram"),
  package: held(s, "power.package"),
  /** `power.cpu_source` (D-065); null when absent (PMP) or not current. */
  cpuSource: held(s, "power.cpu_source"),
  components: selectPowerComponents(s),
});

/**
 * The layout splits power by component (`power.cpu`); a Linux agent does not.
 * On its own for a page that branches on it: `usePower()` would re-render
 * that page on every tick's power values.
 */
export const selectPowerComponents = (s: S): boolean =>
  keysOf(s, "power.cpu").length > 0;

export const selectSensors = (s: S) => ({
  hottest: held(s, "thermal.hottest"),
  cpu: held(s, "thermal.cpu"),
  gpu: held(s, "thermal.gpu"),
  thermalState: held(s, "thermal.state"),
  fanRpm: max(s, "fan.rpm"),
  fanMax: max(s, "fan.max"),
  fanCount: keysOf(s, "fan.rpm").length,
});

/**
 * `net.rx_total` / `net.tx_total`: Rust sums the reported interfaces and makes
 * a total a gap when any of them is (D-092), so this never adds parts.
 */
export const selectNetwork = (s: S) => ({
  rx: held(s, "net.rx_total"),
  tx: held(s, "net.tx_total"),
  linkRate: max(s, "net.link_rate"),
});

/**
 * The reported interface carrying the default route (`LiveStatus.primary_iface`,
 * D-092); null on a VPN route, with no route, or before the first status.
 */
export const selectPrimaryIface = (s: S): string | null =>
  s.status?.primary_iface ?? null;

/** `disk.read_total` / `disk.write_total`, gated like the network totals. */
export const selectDisk = (s: S) => ({
  read: held(s, "disk.read_total"),
  write: held(s, "disk.write_total"),
});

/**
 * Capacity of volume `vol` (the boot volume is `HostInfo.boot_mounts[0]`,
 * D-092). On APFS every volume reports its container's size and free space.
 */
export function selectVolumeCapacity(
  s: HostLive,
  vol: string | null
): { total: number | null; free: number | null; used: number | null } {
  if (vol === null) return { total: null, free: null, used: null };
  return {
    total: held(s, volTotal(vol)),
    free: held(s, volFree(vol)),
    used: held(s, volUsed(vol)),
  };
}

export const selectBattery = (s: S) => ({
  charge: held(s, "battery.charge"),
  charging: held(s, "battery.charging"),
  external: held(s, "battery.external"),
  timeRemainingMin: held(s, "battery.time_remaining"),
  health: held(s, "battery.health"),
  cycles: held(s, "battery.cycles"),
});

/** Sampling state for pills and footers. */
export const selectSampling = (s: S) => ({
  intervalMs: s.status?.interval_ms ?? null,
  /** How often this window gets frames: 2 s or more in Performance mode. */
  framePeriodMs: s.status?.frame_period_ms ?? null,
  paused: s.status?.paused ?? false,
  onBattery: s.status?.on_battery ?? false,
  performance: s.status?.performance ?? "off",
  stale: s.stale,
  connection: s.connection,
});

export const selectSelfCpu = (s: S) => held(s, "self.cpu");

/**
 * The host reports cgroup v2 groups (`Module::Containers`, D-116): a Linux
 * agent's series-backed Containers page. False before capabilities arrive.
 */
export const selectCgroups = (s: S): boolean => {
  const cap = s.capabilities?.modules.containers;
  return typeof cap === "object" && "available" in cap;
};

/** Battery, adapter or charging (`LiveStatus.power_source`, D-092); null before the first status. */
export const selectPowerSource = (s: S): PowerSource | null =>
  s.status?.power_source ?? null;

/** Series in the current layout, for the history size projection; null before one. */
export const selectSeriesCount = (s: S): number | null =>
  currentLayout(s)?.series.length ?? null;

export const useCpu = () => useHost(useShallow(selectCpu));
export const useCpuCores = () => useHost(useShallow(selectCpuCores));
export const useGpu = () => useHost(useShallow(selectGpu));
export const useMemory = () => useHost(useShallow(selectMemory));
export const usePower = () => useHost(useShallow(selectPower));
export const useSensors = () => useHost(useShallow(selectSensors));
export const useNetwork = () => useHost(useShallow(selectNetwork));
export const useDisk = () => useHost(useShallow(selectDisk));
export const useBattery = () => useHost(useShallow(selectBattery));
export const useSampling = () => useHost(useShallow(selectSampling));
export const useSelfCpu = () => useHost(selectSelfCpu);
export const useCgroups = () => useHost(selectCgroups);
export const usePrimaryIface = () => useHost(selectPrimaryIface);
export const usePowerSource = () => useHost(selectPowerSource);
export const usePowerComponents = () => useHost(selectPowerComponents);
export const useSeriesCount = () => useHost(selectSeriesCount);

/**
 * One series over the last `windowMs` on the interval grid, for a live
 * chart. Re-renders when rows are appended (once per tick).
 */
export function useSeriesWindow(key: string, windowMs: number): SeriesWindow {
  const store = useHostStore();
  useHost((s) => s.rowsVersion);
  return seriesWindow(store.getState(), key, windowMs);
}
