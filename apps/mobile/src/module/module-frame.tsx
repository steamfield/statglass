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
import { rangeHeaderOptions } from "./range-control";

/** Carries a failed status refresh to the frame while keeping its page mounted. */
export const ModuleStatusNotice = createContext<ReactNode>(null);

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

/** Renders the module's navigation bar and scrolling sections. */
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
  range: number;
  onRange(ms: number): void;
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
        {subtitle && (
          // The range control fills the bar's trailing side, so the subtitle
          // sits under the bar, as it sits under the title on the Mac.
          <Entrance>
            <Text variant="caption" className="pt-4">
              {subtitle}
            </Text>
          </Entrance>
        )}
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
          ...rangeHeaderOptions(range, onRange),
        }}
      />
      {showDate === undefined ? (
        <ScreenScroll contentContainerClassName="px-4 pb-5">
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
