import { eventId, eventLabel } from "@core/events";
import { formatHistoryTime } from "@core/format";
import type { Event } from "@core/generated/types";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { FlatList, View } from "react-native";
import { Text } from "@/ui/text";

const NO_EVENTS: readonly Event[] = [];

export const EventLabelContext = createContext(eventLabel);

function EventsHeading({ empty }: { empty: boolean }) {
  return (
    <View className="gap-2">
      <Text variant="title">Events</Text>
      {empty && (
        <Text variant="label" accessibilityLiveRegion="polite">
          No events in this range
        </Text>
      )}
    </View>
  );
}

function EventRow({ event, showDate }: { event: Event; showDate: boolean }) {
  const formatEvent = useContext(EventLabelContext);
  return (
    <View className="gap-0.5 border-border border-t py-2">
      <Text variant="body">{formatEvent(event)}</Text>
      <Text variant="caption" tabular>
        {formatHistoryTime(event.ts_ms, showDate)}
      </Text>
    </View>
  );
}

/** Show newest events first. With page content, use a single virtualized scroll. */
export function EventsList({
  events,
  showDate,
  children,
}: {
  events: readonly Event[] | undefined;
  showDate: boolean;
  children?: ReactNode;
}) {
  const rows = useMemo(() => events?.slice().reverse() ?? NO_EVENTS, [events]);
  const heading = <EventsHeading empty={events?.length === 0} />;
  if (children === undefined) {
    return (
      <View className="gap-2">
        {heading}
        {rows.map((event) => (
          <EventRow key={eventId(event)} event={event} showDate={showDate} />
        ))}
      </View>
    );
  }
  return (
    <FlatList
      className="flex-1 bg-background pr-safe pl-safe"
      contentContainerClassName="px-4 pb-5"
      contentInsetAdjustmentBehavior="automatic"
      data={rows}
      initialNumToRender={12}
      keyExtractor={eventId}
      renderItem={({ item }) => <EventRow event={item} showDate={showDate} />}
      ListHeaderComponent={
        <View className="gap-5 pb-2">
          {children}
          {heading}
        </View>
      }
    />
  );
}
