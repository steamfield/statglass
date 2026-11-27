import type { HostId, HostRecord } from "@core/generated/types";
import { failureReason } from "@core/remote-errors";
import {
  Stack,
  useIsFocused,
  useLocalSearchParams,
  useRouter,
} from "expo-router";
import { type ComponentRef, useEffect, useRef, useState } from "react";
import { FlatList, type ScrollView, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PagerHost } from "@/data/demand";
import { useHosts } from "@/data/hosts-list";
import { useHostLiveSubscription } from "@/data/live";
import {
  usePhoneSettings,
  usePhoneSettingsActions,
} from "@/data/phone-settings";
import { rangeHeaderOptions } from "@/module/range-control";
import { screenOptions } from "@/ui/screen-options";
import { ScreenScroll } from "@/ui/screen-scroll";
import { Text } from "@/ui/text";
import { useThemeColors } from "@/ui/theme-colors";
import { HostPage } from "./host-page";

function HostPager({
  host,
  hosts,
  index,
}: {
  host: HostId;
  hosts: HostRecord[];
  index: number;
}) {
  const router = useRouter();
  const dimensions = useWindowDimensions();
  const { left, right } = useSafeAreaInsets();
  const width = dimensions.width - left - right;
  const focused = useIsFocused();
  const list = useRef<FlatList<HostRecord>>(null);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const previousHost = useRef(host);
  const position = useRef({ index, width });
  const [heights, setHeights] = useState<Record<HostId, number>>({});
  const height = heights[host];
  useHostLiveSubscription(host);
  useEffect(() => {
    if (position.current.index !== index || position.current.width !== width) {
      list.current?.scrollToOffset({ offset: index * width, animated: false });
      position.current = { index, width };
    }
    if (previousHost.current !== host) {
      previousHost.current = host;
      // A negative offset is clamped to the top of UIKit's automatic inset.
      scroll.current?.scrollTo({ y: -dimensions.height, animated: false });
    }
  }, [dimensions.height, host, index, width]);

  return (
    // UIKit attaches the collapsible title to the first scroll view.
    <ScreenScroll
      ref={scroll}
      reorderable
      directionalLockEnabled
      contentContainerStyle={{ paddingLeft: left, paddingRight: right }}
    >
      <FlatList
        ref={list}
        data={hosts}
        extraData={host}
        style={height === undefined ? null : { height }}
        contentContainerStyle={{ alignItems: "flex-start" }}
        keyExtractor={(record) => record.id}
        renderItem={({ item }) => (
          <HostPage
            host={item}
            width={width}
            active={focused && item.id === host}
            onLayout={({ nativeEvent: { layout } }) => {
              setHeights((previous) =>
                previous[item.id] === layout.height
                  ? previous
                  : { ...previous, [item.id]: layout.height }
              );
            }}
          />
        )}
        accessibilityLabel="Hosts pager"
        horizontal
        pagingEnabled
        directionalLockEnabled
        contentInsetAdjustmentBehavior="never"
        showsHorizontalScrollIndicator={false}
        initialNumToRender={3}
        windowSize={3}
        initialScrollIndex={index}
        getItemLayout={(_, i) => ({
          index: i,
          length: width,
          offset: width * i,
        })}
        onMomentumScrollEnd={({ nativeEvent }) => {
          const next = Math.round(nativeEvent.contentOffset.x / width);
          const page = hosts[next];
          if (page) {
            position.current = { index: next, width };
            if (page.id !== host) router.setParams({ host: page.id });
          }
        }}
      />
    </ScreenScroll>
  );
}

/** The host route keeps its URL in step with the selected page. */
export function HostScreen() {
  const { host } = useLocalSearchParams<{ host: string }>();
  const hosts = useHosts();
  const index = hosts.data?.findIndex((record) => record.id === host) ?? -1;
  const name = hosts.data?.[index]?.display_name;
  const windowMs = usePhoneSettings((settings) => settings.chartWindowMs);
  const { set } = usePhoneSettingsActions();
  const colors = useThemeColors();
  // React to Dynamic Type changes while this header is already mounted.
  const { fontScale } = useWindowDimensions();
  const header = screenOptions(colors, { largeTitle: true });
  return (
    <>
      <Stack.Screen
        options={{
          ...header,
          ...rangeHeaderOptions(windowMs, (chartWindowMs) =>
            set({ chartWindowMs })
          ),
          title: name ?? "Host",
          headerLargeStyle: { backgroundColor: "transparent" },
          headerLargeTitleStyle: {
            ...header.headerLargeTitleStyle,
            fontSize: 34 * Math.min(fontScale, 1.235),
          },
        }}
      />
      {hosts.data && index >= 0 ? (
        <PagerHost.Provider value={host}>
          <HostPager host={host} hosts={hosts.data} index={index} />
        </PagerHost.Provider>
      ) : (
        <ScreenScroll>
          <Text
            variant="body"
            className="px-4 py-5"
            accessibilityLiveRegion="polite"
          >
            {hosts.isPending
              ? "Loading hosts…"
              : hosts.isError
                ? failureReason(hosts.error, "Couldn’t load hosts.")
                : "This host is no longer in your host list."}
          </Text>
        </ScreenScroll>
      )}
    </>
  );
}
