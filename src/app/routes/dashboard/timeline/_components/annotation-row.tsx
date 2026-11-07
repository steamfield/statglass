import { layoutMarkers } from "@core/chart-math";
import { eventId, eventLabel } from "@core/events";
import { formatClock } from "@core/format";
import type { Event } from "@core/generated/bindings";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { cn } from "~/lib/utils";
import { eventPriority, groupEvents } from "../_lib/events";
import type { Marker } from "../_lib/gaps";

export interface AnnotationRowProps {
  markers: readonly Marker[];
  events?: readonly Event[];
  fromMs: number;
  toMs: number;
  widthPx: number;
  onSelect?: (tMs: number) => void;
  onSelectEvents?: (events: readonly Event[]) => boolean;
  onActiveEvents?: (events: readonly Event[]) => void;
}

/** A narrow event track; each cluster keeps an accessible list of its members. */
export function AnnotationRow({
  markers,
  events = [],
  fromMs,
  toMs,
  widthPx,
  onSelect,
  onSelectEvents,
  onActiveEvents,
}: AnnotationRowProps) {
  const groups = groupEvents(events, fromMs, toMs, widthPx);
  const marks =
    widthPx > 0
      ? layoutMarkers(
          markers.filter((m) => m.kind !== "event"),
          {
            fromMs,
            toMs,
            widthPx,
            measure: (m) => m.label.length * 6 + 16,
            side: () => "start",
          }
        )
      : [];
  return (
    <div className="relative" style={{ height: 32 + (marks.length ? 30 : 0) }}>
      <ul aria-label="Timeline events" className="absolute inset-x-0 top-0 h-7">
        {groups.map((group, index) => {
          const label = eventLabel(group.representative);
          const warning = eventPriority(group.representative) >= 2;
          const nextFraction = groups[index + 1]?.fraction ?? 1;
          const left = Math.max(
            0,
            Math.min(widthPx - 22, group.fraction * widthPx)
          );
          const available = Math.max(22, nextFraction * widthPx - left - 8);
          return (
            <li
              key={group.id}
              className="absolute top-0 flex items-center"
              style={{
                left,
              }}
              onPointerEnter={() => onActiveEvents?.(group.members)}
              onPointerLeave={() => onActiveEvents?.([])}
            >
              <Popover
                onOpenChange={(open) =>
                  onActiveEvents?.(open ? group.members : [])
                }
              >
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    data-event-ts={group.representative.ts_ms}
                    aria-label={`${formatClock(group.representative.ts_ms)} ${label}${group.members.length > 1 ? ` · ${group.members.length} events` : ""}`}
                    title={group.members.map(eventLabel).join("; ")}
                    onFocus={() => onActiveEvents?.(group.members)}
                    onBlur={() => onActiveEvents?.([])}
                    onClick={(event) => {
                      if (onSelectEvents?.(group.members))
                        event.preventDefault();
                      else onSelect?.(group.representative.ts_ms);
                    }}
                    style={{ maxWidth: Math.min(180, available) }}
                    className={cn(
                      "figures flex h-6 min-w-5 items-center justify-center gap-1 overflow-hidden rounded-control border px-1.5 text-[10px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                      warning
                        ? "border-warning/40 bg-warning/10"
                        : "border-border bg-card"
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        warning ? "bg-warning" : "bg-muted-foreground"
                      )}
                    />
                    {available > 100 && warning && (
                      <span className="truncate">{label}</span>
                    )}
                    {group.members.length > 1 && (
                      <span>{group.members.length}</span>
                    )}
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  collisionPadding={12}
                  className="max-h-72 w-80 p-2"
                >
                  <ul
                    aria-label="Events in group"
                    className="flex flex-col gap-1"
                  >
                    {group.members.map((event) => (
                      <li key={eventId(event)}>
                        <PopoverClose asChild>
                          <button
                            type="button"
                            onClick={() => onSelectEvents?.([event])}
                            className="w-full rounded-control px-2 py-1.5 text-left text-[11px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <span className="figures text-muted-foreground">
                              {formatClock(event.ts_ms)}
                            </span>{" "}
                            {eventLabel(event)}
                          </button>
                        </PopoverClose>
                      </li>
                    ))}
                  </ul>
                </PopoverContent>
              </Popover>
            </li>
          );
        })}
      </ul>
      <ul aria-label="Sleep and wake" className="absolute inset-x-0 top-8">
        {marks.map((mark) => (
          <li
            key={`${mark.kind}-${mark.tMs}`}
            className="figures absolute text-[10px] text-muted-foreground"
            style={{ left: mark.leftPx, top: mark.row * 13 }}
          >
            {mark.label}
            {mark.more > 0 && ` +${mark.more}`}
          </li>
        ))}
      </ul>
    </div>
  );
}
