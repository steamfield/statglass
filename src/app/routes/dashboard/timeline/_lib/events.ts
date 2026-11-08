import { eventId, eventPriority } from "@core/events";
import type { Event } from "@core/generated/bindings";

export interface EventGroup {
  id: string;
  representative: Event;
  members: Event[];
  fraction: number;
}

/** Screen-space clusters preserve every identity; zooming naturally separates them. */
export function groupEvents(
  events: readonly Event[],
  fromMs: number,
  toMs: number,
  widthPx: number
): EventGroup[] {
  if (widthPx <= 0 || toMs <= fromMs) return [];
  const groups: EventGroup[] = [];
  const threshold = 40 / widthPx;
  for (const event of events
    .filter((event) => event.ts_ms >= fromMs && event.ts_ms < toMs)
    .sort((a, b) => a.ts_ms - b.ts_ms)) {
    const fraction = Math.min(
      1,
      Math.max(0, (event.ts_ms - fromMs) / (toMs - fromMs))
    );
    const group = groups.at(-1);
    if (group && fraction - group.fraction < threshold) {
      group.members.push(event);
      if (eventPriority(event) > eventPriority(group.representative))
        group.representative = event;
    } else
      groups.push({
        id: eventId(event),
        representative: event,
        members: [event],
        fraction,
      });
  }
  return groups;
}
