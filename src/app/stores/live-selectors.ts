/**
 * React hooks over the per-module live selectors. The selectors themselves
 * live in `@core/live-selectors` (shared with the phone) and are re-exported
 * here so desktop importers keep one path.
 */

import {
  selectBattery,
  selectCgroups,
  selectCpu,
  selectCpuCores,
  selectDisk,
  selectGpu,
  selectMemory,
  selectNetwork,
  selectPower,
  selectPowerComponents,
  selectPowerSource,
  selectPrimaryIface,
  selectSampling,
  selectSelfCpu,
  selectSensors,
  selectSeriesCount,
} from "@core/live-selectors";
import { type SeriesWindow, seriesWindow } from "@core/live-state";
import { useShallow } from "zustand/react/shallow";
import { useHost, useHostStore } from "./host-store";

export {
  clusterFreqKey,
  currentLayout,
  held,
  keysOf,
  selectBattery,
  selectCgroups,
  selectCpu,
  selectCpuCores,
  selectDisk,
  selectGpu,
  selectMemory,
  selectNetwork,
  selectPower,
  selectPowerComponents,
  selectPowerSource,
  selectPrimaryIface,
  selectSampling,
  selectSelfCpu,
  selectSensors,
  selectSeriesCount,
  selectVolumeCapacity,
} from "@core/live-selectors";

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
