import { scaledWindowMs } from "@core/live-window";
import { useGridInterval } from "~/hooks/use-grid-interval";

/**
 * A live chart window designed at 1 s, stretched to keep its sample count at
 * the row spacing in effect (after battery back-off and Performance mode's
 * 2 s frames). Re-renders only when it changes.
 */
export function useScaledWindow(baseMs: number): number {
  const intervalMs = useGridInterval();
  return scaledWindowMs(baseMs, intervalMs);
}
