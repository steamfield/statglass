import { BRUSH_STEP_MS, scopeWords } from "@core/brush";
import { recordedDate } from "@core/chart-range";
import { eventId, eventLabel, eventPriority, eventRange } from "@core/events";
import { formatClock, monthName } from "@core/format";
import { historyUnavailable } from "@core/history-state";
import { spanWords } from "@core/live-window";
import { TriangleAlert } from "lucide-react";
import { useId } from "react";
import { useNavigate } from "react-router";
import { ChartHistoryStatus } from "~/components/chart-history-status";
import { useEventsQuery } from "~/hooks/use-events";
import { useHistoryHealth } from "~/hooks/use-history-health";
import { useModuleEnd } from "~/hooks/use-module-end";
import { useRangeNavigation } from "~/hooks/use-range-navigation";
import { useOpenEdge } from "~/hooks/use-range-scope";
import { useHostClock } from "~/lib/host-clock";
import { cn } from "~/lib/utils";
import { Card } from "~/widgets/card";
import { Swatch } from "~/widgets/legend";
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
  const { apply } = useRangeNavigation();
  const navigate = useNavigate();
  const events = query.events
    .filter((event) => event.ts_ms >= fromMs && event.ts_ms < toMs)
    .sort((a, b) => b.ts_ms - a.ts_ms);
  const scope =
    endMs === null
      ? `in the ${scopeWords(null, windowMs)}`
      : `between ${recordedDate(fromMs)} and ${recordedDate(toMs)}`;

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
          <Swatch step={1} />
          <h3 id={titleId} className="font-[590] text-[13px]">
            Events
          </h3>
        </div>
        {!query.isPending && (
          <span className="figures text-[11px] text-muted-foreground">
            {events.length} in {spanWords(windowMs, endMs)}
          </span>
        )}
      </header>
      {unavailable ? (
        <p role="status" className="text-[12px] text-muted-foreground">
          {unavailable.message}
        </p>
      ) : query.isError ? (
        <p role="alert" className="text-[12px] text-muted-foreground">
          Couldn't load events
        </p>
      ) : query.isPending ? (
        <ChartHistoryStatus loading />
      ) : events.length === 0 ? (
        <p role="status" className="text-[12px] text-muted-foreground">
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
                  className={cn(
                    "flex w-full items-baseline gap-2 rounded-control py-1 text-left text-[12px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                    warning ? "text-warning" : "text-fg-subtle"
                  )}
                  onClick={async () => {
                    const range = eventRange(
                      [event],
                      BRUSH_STEP_MS,
                      clock(),
                      health?.trimmed_before_ms ?? 0
                    );
                    if (range)
                      await apply({
                        absolute: { from_ms: range.fromMs, to_ms: range.toMs },
                      });
                    navigate("/dashboard/timeline");
                  }}
                >
                  <span className="figures shrink-0 text-[11px] text-muted-foreground">
                    {eventTime(event.ts_ms, toMs)}
                  </span>
                  {warning && (
                    <TriangleAlert
                      aria-hidden
                      className="size-3 shrink-0 self-center"
                    />
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
