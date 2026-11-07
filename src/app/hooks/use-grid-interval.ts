import { gridIntervalMs } from "@core/live-state";
import { useHost } from "~/stores/host-store";

/**
 * The row spacing live charts lay samples on (`gridIntervalMs`). A number,
 * so a reader re-renders only when the cadence changes, not every tick.
 */
export function useGridInterval(): number {
  return useHost((s) => gridIntervalMs(s.status));
}
