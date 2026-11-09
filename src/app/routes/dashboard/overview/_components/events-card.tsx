import { BRUSH_STEP_MS, rangeScopeWords } from "@core/brush";
import { eventId, eventLabel, eventPriority, eventRange } from "@core/events";
import { formatClock, monthName } from "@core/format";
import type { Event } from "@core/generated/bindings";
import { historyUnavailable } from "@core/history-state";
import { TriangleAlert } from "lucide-react";
import { useId, useRef } from "react";
import { useNavigate } from "react-router";
import { ChartHistoryStatus } from "~/components/chart-history-status";
import { useEventsQuery } from "~/hooks/use-events";
import { useHistoryHealth } from "~/hooks/use-history-health";
import { useModuleEnd } from "~/hooks/use-module-end";
import { useRangeNavigation } from "~/hooks/use-range-navigation";
import { useOpenEdge } from "~/hooks/use-range-scope";
import { useHostClock } from "~/lib/host-clock";
import { Card } from "~/widgets/card";
import type { Corner } from "~/widgets/lib/accent";

export function OverviewEventsCard({
  windowMs,
  origin,
}: {
  windowMs: number;
  origin: Corner;
}) {
  const titleId = useId();
  const endMs = useModuleEnd();
  const clock = useHostClock();
  // Expire scrolled-out events at the range cadence, without subscribing at 1 Hz.
  useOpenEdge(endMs === null);
  const toMs = endMs ?? clock();
  const fromMs = toMs - windowMs;
  const query = useEventsQuery(windowMs, endMs);
  const { health, error } = useHistoryHealth();
  const unavailable = error ? historyUnavailable(error) : null;
  const { apply, pending, range: currentRange } = useRangeNavigation();
  const opening = useRef(false);
  const navigate = useNavigate();
  const events = query.events
    .filter((event) => event.ts_ms >= fromMs && event.ts_ms < toMs)
    .sort((a, b) => b.ts_ms - a.ts_ms);
  const scope = rangeScopeWords(windowMs, endMs);
  const openEvent = async (event: Event) => {
    if (opening.current || pending) return;
    const range = eventRange(
      [event],
      BRUSH_STEP_MS,
      clock(),
      health?.trimmed_before_ms ?? 0
    );
    if (!range) return;
    opening.current = true;
    const applied = await apply({
      absolute: { from_ms: range.fromMs, to_ms: range.toMs },
    });
    opening.current = false;
    // A no-op is safe only when these absolute bounds are active.
    if (
      applied ||
      (currentRange?.endMs === range.toMs &&
        currentRange.windowMs === range.toMs - range.fromMs)
    )
      navigate("/dashboard/timeline");
  };

  return (
    <Card
      accent="cpu"
      origin={origin}
      variant="chart"
      labelledBy={titleId}
      className="flex min-w-0 flex-col gap-3 px-4 py-3.5"
    >
      <header className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h3 id={titleId} className="font-semibold text-body">
            Events
          </h3>
        </div>
        {!query.isPending && !query.isError && !unavailable && (
          <span className="figures text-label text-muted-foreground">
            {events.length} {scope}
          </span>
        )}
      </header>
      {unavailable ? (
        <p role="status" className="text-muted-foreground text-small">
          {unavailable.message}
        </p>
      ) : query.isError ? (
        <p role="alert" className="text-muted-foreground text-small">
          Couldn't load events
        </p>
      ) : query.isPending ? (
        <ChartHistoryStatus loading />
      ) : events.length === 0 ? (
        <p role="status" className="text-muted-foreground text-small">
          Nothing detected {scope}
        </p>
      ) : (
        <ul aria-label="Recent events" className="flex flex-col gap-1">
          {events.slice(0, 6).map((event) => {
            const warning = eventPriority(event) >= 2;
            return (
              <li key={eventId(event)}>
                <button
                  type="button"
                  aria-description="Open in Timeline"
                  disabled={pending}
                  className="flex w-full items-baseline gap-2 rounded-control py-1 text-left text-fg-subtle text-small outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => void openEvent(event)}
                >
                  <span className="figures shrink-0 text-label text-muted-foreground">
                    {eventTime(event.ts_ms, toMs)}
                  </span>
                  {warning && (
                    <>
                      <TriangleAlert
                        aria-hidden
                        className="size-3 shrink-0 self-center text-warning"
                      />
                      <span className="sr-only">Warning</span>
                    </>
                  )}
                  <span className="min-w-0 truncate" title={eventLabel(event)}>
                    {eventLabel(event)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/**
 * "14:56" for an event on the range end's day, "Nov 7, 14:56" otherwise: a
 * live 24 h range crosses midnight, so the date can't follow the span alone.
 */
function eventTime(ms: number, toMs: number): string {
  const d = new Date(ms);
  const end = new Date(toMs);
  return d.toDateString() === end.toDateString()
    ? formatClock(ms)
    : `${monthName(d)} ${d.getDate()}, ${formatClock(ms)}`;
}
