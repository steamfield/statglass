import { niceCeiling } from "@core/chart-math";
import type { HostId } from "@core/generated/types";
import { seriesWindow } from "@core/live-state";
import { MINUTE_MS } from "@core/time-grid";
import { useHostLive } from "@/data/live";

/** The live rings keep their own scale when the user changes the chart range. */
export function useWattRingCeiling(
  host: HostId,
  key: "power.system" | "battery.power",
  live: boolean,
  current: number | null,
  floor: number
) {
  const peak = useHostLive(host, (state) =>
    live
      ? seriesWindow(state, key, 10 * MINUTE_MS).values.reduce<number>(
          (max, value) => Math.max(max, Math.abs(value ?? 0)),
          0
        )
      : 0
  );
  return niceCeiling(Math.max(peak, Math.abs(current ?? 0)), floor);
}
