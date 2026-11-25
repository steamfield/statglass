/**
 * The Alerts page's Recent panel: the alerts this host fired in the last
 * 7 days, newest first, each one a line that opens the Timeline at it.
 */
import type { TimeRange } from "@core/brush";
import { alertLabel, eventId } from "@core/events";
import { formatClock, monthName } from "@core/format";
import type { UnitSettings } from "@core/generated/bindings";
import type { ReactNode } from "react";
import { InlineMessage } from "~/components/inline-message";
import { SettingsPanel } from "~/components/settings-row";
import { useOpenInTimeline } from "~/hooks/use-open-in-timeline";
import { useHostClock } from "~/lib/host-clock";
import { useSettings } from "~/stores/settings-store";
import { type AlertEvent, useRecentAlerts } from "../_hooks/use-recent-alerts";

/** The most alerts the panel lists. */
const MAX_RECENT_ALERTS = 20;

const EMPTY_TEXT = "No alerts in the last 7 days.";
const LOADING_TEXT = "Loading alerts…";
const ERROR_TEXT = "Couldn't load alerts";
const OPEN_DESCRIPTION = "Open in Timeline";
const NOT_KEPT_DESCRIPTION = "The history from this time is no longer kept";

/**
 * A `SettingsPanel` titled "Recent": at most 20 alerts from
 * `useRecentAlerts`, newest first, each line its time on the host clock,
 * `alertLabel` in the user's units and a control that opens the Timeline at that alert. "No
 * alerts in the last 7 days." when there are none or history is
 * unavailable; "Couldn't load alerts" when the read failed otherwise.
 */
export function RecentAlerts(): ReactNode {
  const { alerts, isPending, isError } = useRecentAlerts();
  const clock = useHostClock();
  const { rangeFor, open, pending } = useOpenInTimeline();
  const units = useSettings((s) => s.units);
  const shown = alerts.slice(0, MAX_RECENT_ALERTS);
  return (
    <SettingsPanel title="Recent">
      {shown.length > 0 && (
        <ul>
          {shown.map((alert) => (
            <RecentAlertLine
              key={eventId(alert)}
              alert={alert}
              units={units}
              nowMs={clock()}
              range={rangeFor(alert)}
              busy={pending}
              onOpen={(range) => void open(range)}
            />
          ))}
        </ul>
      )}
      {isError ? (
        <InlineMessage tone="error" className="px-4 py-3.5">
          {ERROR_TEXT}
        </InlineMessage>
      ) : (
        shown.length === 0 && (
          <InlineMessage tone="status" className="px-4 py-3.5">
            {isPending ? LOADING_TEXT : EMPTY_TEXT}
          </InlineMessage>
        )
      )}
    </SettingsPanel>
  );
}

/**
 * One alert as a full-width row button: its label over its time. With no
 * `range` (its history is no longer kept) the button is disabled and says
 * why.
 */
function RecentAlertLine({
  alert,
  units,
  nowMs,
  range,
  busy,
  onOpen,
}: {
  alert: AlertEvent;
  units: UnitSettings | null;
  nowMs: number;
  range: TimeRange | null;
  busy: boolean;
  onOpen: (range: TimeRange) => void;
}) {
  const label = alertLabel(alert, units);
  return (
    <li className="border-border-subtle border-b last:border-b-0">
      <button
        type="button"
        aria-description={range ? OPEN_DESCRIPTION : NOT_KEPT_DESCRIPTION}
        disabled={busy || range === null}
        onClick={() => {
          if (range) onOpen(range);
        }}
        className="flex min-h-12 w-full flex-col justify-center gap-0.5 px-4 py-2 text-left text-body outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset enabled:hover:bg-muted"
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
