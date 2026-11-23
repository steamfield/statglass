/**
 * Opening the Timeline at a recorded event: the range around it, and the
 * save-then-navigate step that every "open in Timeline" link shares, so the
 * Overview's events card and the Alerts page open the same view.
 */
import { BRUSH_STEP_MS, type TimeRange } from "@core/brush";
import { eventRange } from "@core/events";
import type { Event } from "@core/generated/bindings";
import { useCallback, useRef } from "react";
import { useNavigate } from "react-router";
import { useHistoryHealth } from "~/hooks/use-history-health";
import { useRangeNavigation } from "~/hooks/use-range-navigation";
import { useHostClock } from "~/lib/host-clock";

/** What `useOpenInTimeline` returns. */
export interface OpenInTimeline {
  /**
   * The absolute range the Timeline shows for `event`, cut to now and to
   * the retained history; null when none of its time is still kept.
   */
  rangeFor: (event: Event) => TimeRange | null;
  /** Makes `range` the chart window, then opens the Timeline on it. */
  open: (range: TimeRange) => Promise<void>;
  /** True while a range save is in flight; links should be disabled. */
  pending: boolean;
}

/**
 * Opens the Timeline on an absolute range around an event. `open` saves the
 * range through `useRangeNavigation` (which reports a failed save itself)
 * and navigates once that range is the active one, including when it was
 * already active and the save was a no-op. A click while a save is in
 * flight is ignored.
 */
export function useOpenInTimeline(): OpenInTimeline {
  const clock = useHostClock();
  const { health } = useHistoryHealth();
  const { apply, pending, range: currentRange } = useRangeNavigation();
  const navigate = useNavigate();
  // `pending` lags a render behind the first click; the ref does not.
  const opening = useRef(false);
  const retainedFromMs = health?.trimmed_before_ms ?? 0;

  const rangeFor = useCallback(
    (event: Event) =>
      eventRange([event], BRUSH_STEP_MS, clock(), retainedFromMs),
    [clock, retainedFromMs]
  );

  const open = async (range: TimeRange) => {
    if (opening.current || pending) return;
    opening.current = true;
    const applied = await apply({
      absolute: { from_ms: range.fromMs, to_ms: range.toMs },
    });
    opening.current = false;
    // `apply` also returns false for a failed save; navigate only when the
    // range on screen is the one asked for.
    const alreadyActive =
      currentRange?.endMs === range.toMs &&
      currentRange.windowMs === range.toMs - range.fromMs;
    if (applied || alreadyActive) navigate("/dashboard/timeline");
  };

  return { rangeFor, open, pending };
}
