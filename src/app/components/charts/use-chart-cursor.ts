import { nearestTime } from "@core/chart-math";
import { useState } from "react";

/**
 * The cursor of a chart whose plotted times are uneven or sparse: the
 * hovered time, snapped to the nearest plotted one. With nothing hovered it
 * rests at `restAt` (a pinned selection's start), or hides. Feed
 * `setHoverTime` from `BrushOverlay`'s `onHoverTime`.
 *
 * It re-renders on each hover move. Charts that must not (the mirror bars)
 * keep the imperative path: `indexAt` and `paintCrosshairs`.
 */
export function useChartCursor(
  times: readonly number[],
  restAt: number | null = null
): {
  hoverTime: number | null;
  setHoverTime: (time: number | null) => void;
  cursor: number | null;
} {
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const at = hoverTime ?? restAt;
  return {
    hoverTime,
    setHoverTime,
    cursor: at === null ? null : nearestTime(times, at),
  };
}
