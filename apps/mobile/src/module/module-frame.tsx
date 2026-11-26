import type { Event } from "@core/generated/types";
import { Stack } from "expo-router";
import { createContext, type ReactNode, useContext } from "react";
import { View } from "react-native";
import { ScreenScroll } from "@/ui/screen-scroll";
import { Text } from "@/ui/text";
import { EventsList } from "./events-list";
import type { HistoryRangeChoice } from "./pages";
import { RangeControl } from "./range-control";

/** Carries a failed status refresh to the frame while keeping its page mounted. */
export const ModuleStatusNotice = createContext<ReactNode>(null);

const HEADER_MAX_SCALE = 1.35;

export function ModuleFrame({
  title,
  subtitle,
  range,
  onRange,
  children,
  events,
  showDate,
}: {
  title: string;
  subtitle: string | null;
  range: HistoryRangeChoice;
  onRange(r: HistoryRangeChoice): void;
  children: ReactNode;
  /** Passing an events reply keeps its rows virtualized in the screen's scroll. */
  events?: readonly Event[] | undefined;
  showDate?: boolean;
}) {
  const statusNotice = useContext(ModuleStatusNotice);
  const body = (
    <View className="gap-5">
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
                // UIKit stops scaling navigation bar titles near xxxLarge, so
                // the two-line title stops there too and stays inside the bar.
                headerTitle: () => (
                  <View className="min-w-0 items-center">
                    <Text
                      variant="body"
                      accessibilityRole="header"
                      weight="semibold"
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.75}
                      maxFontSizeMultiplier={HEADER_MAX_SCALE}
                    >
                      {title}
                    </Text>
                    <Text
                      variant="caption"
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.75}
                      maxFontSizeMultiplier={HEADER_MAX_SCALE}
                    >
                      {subtitle}
                    </Text>
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
