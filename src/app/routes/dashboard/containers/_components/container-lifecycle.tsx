import { errorTone } from "@core/command-error";
import { formatDateTime } from "@core/format";
import { InlineMessage } from "~/components/inline-message";
import { Button } from "~/components/ui/button";
import type { useDockerEvents } from "../_hooks/use-docker";
import { dockerErrorMessage } from "../_lib/presentation";
export function ContainerLifecycle({
  events,
  eventCursor,
  setEventCursor,
}: {
  events: ReturnType<typeof useDockerEvents>;
  eventCursor: string | null;
  setEventCursor: (value: string | null) => void;
}) {
  return (
    <section aria-label="Lifecycle events" className="flex flex-col gap-2">
      <h2 className="text-[14px]">Lifecycle evidence</h2>
      {events.error && (
        <InlineMessage tone={errorTone(events.error)}>
          Events unavailable: {dockerErrorMessage(events.error)}
        </InlineMessage>
      )}
      {events.data?.events.map((event) => (
        <div
          key={event.id}
          className="flex flex-wrap gap-3 border-border-subtle border-b py-2 text-[12px]"
        >
          <time
            className="figures text-muted-foreground"
            dateTime={new Date(event.time_ms).toISOString()}
          >
            {formatDateTime(event.time_ms)}
          </time>
          <span>
            {event.action}
            {event.exit_code !== null ? ` · exit ${event.exit_code}` : ""}
          </span>
          {event.action === "oom" && <span>Explicit Docker OOM event</span>}
        </div>
      ))}
      {events.data?.events.length === 0 && (
        <InlineMessage tone="status">
          No recorded lifecycle events in this range.
        </InlineMessage>
      )}
      <div className="flex gap-2">
        {eventCursor && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setEventCursor(null)}
          >
            Latest events
          </Button>
        )}
        {events.data?.next_id && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setEventCursor(events.data?.next_id ?? null)}
          >
            Older events
          </Button>
        )}
      </div>
      {events.data?.coverage.map((gap) => (
        <p key={gap.start_ms} className="text-[11px] text-muted-foreground">
          Event coverage: {gap.label}
        </p>
      ))}
    </section>
  );
}
