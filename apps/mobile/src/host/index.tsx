import type { HostId, HostRecord } from "@core/generated/types";
import { failureReason } from "@core/remote-errors";
import { useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { FlatList, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PagerHost } from "@/data/demand";
import { useHosts } from "@/data/hosts-list";
import { useHostLiveSubscription } from "@/data/live";
import { Text } from "@/ui/text";
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
  const position = useRef({ index, width });
  useHostLiveSubscription(host);
  useEffect(() => {
    if (position.current.index !== index || position.current.width !== width) {
      list.current?.scrollToOffset({ offset: index * width, animated: false });
      position.current = { index, width };
    }
  }, [index, width]);

  return (
    <FlatList
      ref={list}
      data={hosts}
      extraData={host}
      keyExtractor={(record) => record.id}
      renderItem={({ item }) => (
        <HostPage
          host={item}
          width={width}
          active={focused && item.id === host}
        />
      )}
      accessibilityLabel="Hosts pager"
      horizontal
      pagingEnabled
      showsHorizontalScrollIndicator={false}
      initialScrollIndex={index}
      getItemLayout={(_, i) => ({ index: i, length: width, offset: width * i })}
      onMomentumScrollEnd={({ nativeEvent }) => {
        const next = Math.round(nativeEvent.contentOffset.x / width);
        const page = hosts[next];
        if (page) {
          position.current = { index: next, width };
          if (page.id !== host) router.setParams({ host: page.id });
        }
      }}
    />
  );
}

/** The host route keeps its URL in step with the selected page. */
export function HostScreen() {
  const { host } = useLocalSearchParams<{ host: string }>();
  const hosts = useHosts();
  const index = hosts.data?.findIndex((record) => record.id === host) ?? -1;
  return (
    <View className="flex-1 bg-background pr-safe pl-safe">
      {hosts.data && index >= 0 ? (
        <PagerHost.Provider value={host}>
          <HostPager host={host} hosts={hosts.data} index={index} />
        </PagerHost.Provider>
      ) : (
        <Text
          {...{ role: "body" }}
          className="px-4 py-5"
          accessibilityLiveRegion="polite"
        >
          {hosts.isPending
            ? "Loading hosts…"
            : hosts.isError
              ? failureReason(hosts.error, "Couldn’t load hosts.")
              : "This host is no longer in your host list."}
        </Text>
      )}
    </View>
  );
}
