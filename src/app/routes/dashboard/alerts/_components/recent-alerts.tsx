/**
 * The Alerts page's Recent panel: the alerts This Mac fired in the last
 * 7 days, newest first, each one a line that opens the Timeline at it.
 */
import { BRUSH_STEP_MS } from "@core/brush";
import { eventId, eventLabel, eventRange } from "@core/events";
import { formatClock, monthName } from "@core/format";
import type { ReactNode } from "react";
import { useRef } from "react";
import { useNavigate } from "react-router";
import { InlineMessage } from "~/components/inline-message";
import { SettingsPanel } from "~/components/settings-row";
import { useHistoryHealth } from "~/hooks/use-history-health";
import { useRangeNavigation } from "~/hooks/use-range-navigation";
import { useHostClock } from "~/lib/host-clock";
import { type AlertEvent, useRecentAlerts } from "../_hooks/use-recent-alerts";

/** The most alerts the panel lists. */
const MAX_RECENT_ALERTS = 20;

const EMPTY_TEXT = "No alerts in the last 7 days.";
const LOADING_TEXT = "Loading alerts…";

/**
 * A `SettingsPanel` titled "Recent": at most 20 alerts from
 * `useRecentAlerts`, newest first, each line its time on the host clock,
 * `eventLabel` and a control that opens the Timeline at that alert. "No
 * alerts in the last 7 days." when there are none or history is
 * unavailable.
 */
export function RecentAlerts(): ReactNode {
  const { alerts, isPending } = useRecentAlerts();
  const clock = useHostClock();
  const { openAt, pending } = useOpenTimelineAt();
  const shown = alerts.slice(0, MAX_RECENT_ALERTS);
  return (
    <SettingsPanel title="Recent">
      {shown.length > 0 ? (
        <ul>
          {shown.map((alert) => (
            <RecentAlertLine
              key={eventId(alert)}
              alert={alert}
              nowMs={clock()}
              disabled={pending}
              onOpen={() => void openAt(alert)}
            />
          ))}
        </ul>
      ) : (
        <InlineMessage tone="status" className="px-4 py-3.5">
          {isPending ? LOADING_TEXT : EMPTY_TEXT}
        </InlineMessage>
      )}
    </SettingsPanel>
  );
}

/** One alert as a full-width row button: its label over its time. */
function RecentAlertLine({
  alert,
  nowMs,
  disabled,
  onOpen,
}: {
  alert: AlertEvent;
  nowMs: number;
  disabled: boolean;
  onOpen: () => void;
}) {
  const label = eventLabel(alert);
  return (
    <li className="border-border-subtle border-b last:border-b-0">
      <button
        type="button"
        aria-description="Open in Timeline"
        disabled={disabled}
        onClick={onOpen}
        className="flex min-h-12 w-full flex-col justify-center gap-0.5 px-4 py-2 text-left text-body outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <span className="min-w-0 truncate" title={label}>
          {label}
        </span>
        <span className="figures font-normal text-muted-foreground text-small">
          {alertTime(alert.ts_ms, nowMs)}
        </span>
      </button>
    </li>
  );
}

/**
 * Opens the Timeline on an absolute range around one alert, the way the
 * Overview's events card does: apply the range, then navigate once it is
 * the active one. A failed range save is reported by `useRangeNavigation`.
 */
function useOpenTimelineAt() {
  const clock = useHostClock();
  const { health } = useHistoryHealth();
  const { apply, pending, range: currentRange } = useRangeNavigation();
  const navigate = useNavigate();
  // A second click before the first range is saved would queue a second save.
  const opening = useRef(false);

  const openAt = async (alert: AlertEvent) => {
    if (opening.current || pending) return;
    const range = eventRange(
      [alert],
      BRUSH_STEP_MS,
      clock(),
      health?.trimmed_before_ms ?? 0
    );
    // Null only for an alert older than the retained history: nothing to show.
    if (!range) return;
    opening.current = true;
    const applied = await apply({
      absolute: { from_ms: range.fromMs, to_ms: range.toMs },
    });
    opening.current = false;
    // `apply` returns false when the range is already active; navigate then too.
    const alreadyActive =
      currentRange?.endMs === range.toMs &&
      currentRange.windowMs === range.toMs - range.fromMs;
    if (applied || alreadyActive) navigate("/dashboard/timeline");
  };

  return { openAt, pending };
}

/**
 * "14:56" for an alert on the same day as `nowMs`, "Nov 7, 14:56" for an
 * earlier day: the list spans a week, so the clock alone is ambiguous.
 */
function alertTime(ms: number, nowMs: number): string {
  const day = new Date(ms);
  if (day.toDateString() === new Date(nowMs).toDateString()) {
    return formatClock(ms);
  }
  return `${monthName(day)} ${day.getDate()}, ${formatClock(ms)}`;
}
