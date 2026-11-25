import type { Event } from "@core/generated/types";
import { Stack } from "expo-router";
import { createContext, type ReactNode, useContext } from "react";
import { useWindowDimensions, View } from "react-native";
import { ScreenScroll } from "@/ui/screen-scroll";
import { Text } from "@/ui/text";
import { EventsList } from "./events-list";
import type { HistoryRangeChoice } from "./pages";
import { RangeControl } from "./range-control";

/** Carries a failed status refresh to the frame while keeping its page mounted. */
export const ModuleStatusNotice = createContext<ReactNode>(null);

export function ModuleFrame({
  title,
  subtitle,
  subtitleDetail,
  subtitleHint,
  range,
  onRange,
  children,
  events,
  showDate,
}: {
  title: string;
  subtitle: string | null;
  subtitleDetail?: string | null;
  subtitleHint?: string | null;
  range: HistoryRangeChoice;
  onRange(r: HistoryRangeChoice): void;
  children: ReactNode;
  /** Passing an events reply keeps its rows virtualized in the screen's scroll. */
  events?: readonly Event[] | undefined;
  showDate?: boolean;
}) {
  const statusNotice = useContext(ModuleStatusNotice);
  const { fontScale } = useWindowDimensions();
  // The scrolling page gives address captions room to wrap at accessibility sizes.
  const captionsInBody = subtitleDetail !== undefined && fontScale >= 1.5;
  const captions = subtitle && (
    <>
      <Text
        variant="caption"
        accessibilityHint={subtitleHint ?? undefined}
        {...(captionsInBody
          ? { className: "text-center" }
          : {
              numberOfLines: 1,
              adjustsFontSizeToFit: true,
              minimumFontScale: 0.75,
            })}
      >
        {subtitle}
      </Text>
      {subtitleDetail && (
        <Text variant="caption" className="text-center">
          {subtitleDetail}
        </Text>
      )}
    </>
  );
  const body = (
    <View className="gap-5">
      {captionsInBody && captions && (
        <View className="items-center gap-0.5">{captions}</View>
      )}
      <RangeControl value={range} onChange={onRange} />
      {statusNotice}
      {children}
    </View>
  );
  return (
    <>
      <Stack.Screen
        options={{
          title,
          headerLargeTitle: false,
          ...(subtitle
            ? {
                headerTitle: () => (
                  <View className="min-w-0 items-center">
                    <Text
                      variant="body"
                      accessibilityRole="header"
                      className="font-semibold!"
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.75}
                    >
                      {title}
                    </Text>
                    {!captionsInBody && captions}
                  </View>
                ),
              }
            : {}),
        }}
      />
      {showDate === undefined ? (
        <ScreenScroll contentContainerClassName="px-4 pt-4 pb-5">
          {body}
        </ScreenScroll>
      ) : (
        <EventsList events={events} showDate={showDate}>
          {body}
        </EventsList>
      )}
    </>
  );
}
