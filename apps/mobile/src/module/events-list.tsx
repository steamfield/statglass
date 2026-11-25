import { errorTone } from "@core/command-error";
import { eventId, eventLabel } from "@core/events";
import { formatHistoryTime } from "@core/format";
import type { Event } from "@core/generated/types";
import { type ReactNode, useMemo } from "react";
import { FlatList, View } from "react-native";
import { historyReadError, type useEvents } from "@/data/history";
import { Text } from "@/ui/text";

function EventsHeading({ events }: { events: ReturnType<typeof useEvents> }) {
  return (
    <View className="gap-2">
      <Text {...{ role: "title" }}>Events</Text>
      {events.isPending && (
        <Text {...{ role: "label" }} accessibilityLiveRegion="polite">
          Loading events…
        </Text>
      )}
      {events.isError && (
        <Text
          {...{ role: "label" }}
          accessibilityLiveRegion="polite"
          accessibilityRole={
            errorTone(events.error) === "error" ? "alert" : undefined
          }
          className={
            errorTone(events.error) === "error" ? "text-destructive" : ""
          }
        >
          {historyReadError(events.error, "events")}
        </Text>
      )}
      {events.isSuccess && events.data.length === 0 && (
        <Text {...{ role: "label" }} accessibilityLiveRegion="polite">
          No events in this range
        </Text>
      )}
    </View>
  );
}

function EventRow({ event, showDate }: { event: Event; showDate: boolean }) {
  return (
    <View className="gap-0.5 border-border border-t py-2">
      <Text {...{ role: "body" }}>{eventLabel(event)}</Text>
      <Text {...{ role: "caption" }} className="tabular-nums">
        {formatHistoryTime(event.ts_ms, showDate)}
      </Text>
    </View>
  );
}

/** Show the module content above a virtualized, newest-first list of events. */
export function EventsList({
  events,
  showDate,
  children,
}: {
  events: ReturnType<typeof useEvents>;
  showDate: boolean;
  children: ReactNode;
}) {
  const rows = useMemo(
    () => events.data?.slice().reverse() ?? [],
    [events.data]
  );
  return (
    <FlatList
      className="flex-1 bg-background pr-safe pl-safe"
      contentContainerClassName="px-4 py-4"
      contentInsetAdjustmentBehavior="automatic"
      data={rows}
      initialNumToRender={12}
      keyExtractor={eventId}
      renderItem={({ item }) => <EventRow event={item} showDate={showDate} />}
      ListHeaderComponent={
        <View className="gap-5 pb-2">
          {children}
          <EventsHeading events={events} />
        </View>
      }
    />
  );
}
