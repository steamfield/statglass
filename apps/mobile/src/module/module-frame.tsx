import type { Event } from "@core/generated/types";
import { Stack } from "expo-router";
import {
  Children,
  createContext,
  Fragment,
  isValidElement,
  type ReactNode,
  useContext,
  useState,
} from "react";
import { View } from "react-native";
import { Entrance, EntranceProvider } from "@/ui/entrance";
import { ScreenScroll } from "@/ui/screen-scroll";
import { Text } from "@/ui/text";
import { EventsList } from "./events-list";
import type { HistoryRangeChoice } from "./pages";
import { RangeControl } from "./range-control";

/** Carries a failed status refresh to the frame while keeping its page mounted. */
export const ModuleStatusNotice = createContext<ReactNode>(null);

const HEADER_MAX_SCALE = 1.35;

/**
 * The page's top-level sections, with fragments opened so each card of a
 * `connected ? <>…</> : …` branch enters on its own.
 */
function sections(
  children: ReactNode,
  prefix = ""
): { key: string; node: ReactNode }[] {
  return Children.toArray(children).flatMap((child, index) => {
    const key = `${prefix}${isValidElement(child) && child.key !== null ? child.key : index}`;
    if (
      isValidElement<{ children?: ReactNode }>(child) &&
      child.type === Fragment
    )
      return sections(child.props.children, `${key}/`);
    return [{ key, node: child }];
  });
}

/**
 * One entering section. Its own gap spaces a fragment a component returns,
 * and a section that renders nothing drops its spacing, as it would without
 * the wrapper: the page's sections are spaced by padding, not the parent's gap.
 */
function Section({ children }: { children: ReactNode }) {
  const [empty, setEmpty] = useState(false);
  return (
    <Entrance>
      <View className={empty ? "" : "pt-5"}>
        <View
          className="gap-5"
          onLayout={({ nativeEvent }) =>
            setEmpty(nativeEvent.layout.height === 0)
          }
        >
          {children}
        </View>
      </View>
    </Entrance>
  );
}

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
  // Each section of the page enters in reading order, as a desktop module page does.
  const body = (
    <EntranceProvider>
      <View>
        <Entrance>
          <RangeControl value={range} onChange={onRange} />
        </Entrance>
        {statusNotice && <Section>{statusNotice}</Section>}
        {sections(children).map(({ key, node }) => (
          <Section key={key}>{node}</Section>
        ))}
      </View>
    </EntranceProvider>
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
