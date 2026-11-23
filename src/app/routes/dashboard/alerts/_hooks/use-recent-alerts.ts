/**
 * The alerts This Mac fired over the last 7 days, for the Alerts page's
 * Recent list and the rules' last-fired lines. Reads through the shared
 * events query, so a pushed alert shows without a refetch.
 */
import type { Event, EventDetail } from "@core/generated/bindings";
import { historyUnavailable } from "@core/history-state";
import { DAY_MS } from "@core/time-grid";
import { useMemo } from "react";
import { useEventsQuery } from "~/hooks/use-events";
import { useHistoryHealth } from "~/hooks/use-history-health";
import { useHostClock } from "~/lib/host-clock";

/** How far back the Alerts page looks. */
export const RECENT_ALERTS_SPAN_MS = 7 * DAY_MS;

/** An event whose detail is a fired alert. */
export type AlertEvent = Event & {
  detail: Extract<EventDetail, { kind: "alert" }>;
};

/** What `useRecentAlerts` returns. */
export interface RecentAlerts {
  /** Alert events of the last 7 days, newest first. */
  alerts: readonly AlertEvent[];
  /** True until the first read settles (or while a held read is shown). */
  isPending: boolean;
  /**
   * True when the read failed for a reason other than history being
   * unavailable, so an empty `alerts` does not mean there were none.
   */
  isError: boolean;
}

function isAlert(event: Event): event is AlertEvent {
  return event.detail.kind === "alert";
}

/**
 * Alert events (`detail.kind === "alert"`) of the last 7 days, newest
 * first. The host is the current store's, which on the Alerts page is
 * always This Mac: the dashboard layout renders Alerts in the local host's
 * store whichever host is selected. History unavailable reads as no alerts;
 * any other failed read is `isError`.
 */
export function useRecentAlerts(): RecentAlerts {
  const clock = useHostClock();
  const { events, isPending, isError } = useEventsQuery(
    RECENT_ALERTS_SPAN_MS,
    null
  );
  const health = useHistoryHealth();
  const alerts = useMemo(() => {
    // A live list keeps events that scrolled out until its next read.
    const fromMs = clock() - RECENT_ALERTS_SPAN_MS;
    return events
      .filter(isAlert)
      .filter((event) => event.ts_ms >= fromMs)
      .sort((a, b) => b.ts_ms - a.ts_ms);
  }, [events, clock]);
  if (!isError) return { alerts, isPending, isError: false };
  // A failed read is only known not to be "history unavailable" once the
  // store's health has answered; until then it stays pending.
  const healthKnown = health.health !== undefined || health.error !== null;
  const unavailable =
    health.error !== null && historyUnavailable(health.error) !== null;
  return {
    alerts,
    isPending: !healthKnown,
    isError: healthKnown && !unavailable,
  };
}
