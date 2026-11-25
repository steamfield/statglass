import type { HostId, HostRecord } from "@core/generated/types";
import { PHONE_OFFLINE_TITLE } from "@core/phone-connection";
import { failureReason } from "@core/remote-errors";
import { useState } from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  useWindowDimensions,
  View,
} from "react-native";
import { useStatusAnnouncement } from "@/connection/use-status-announcement";
import { RowVisibility, useVisibleHosts } from "@/data/demand";
import {
  type HostRetryFailure,
  useHostListUpdates,
  useHostsWaitingForNetwork,
  useRefreshHosts,
} from "@/data/hosts";
import { useHosts } from "@/data/hosts-list";
import { usePhoneSettingsActions } from "@/data/phone-settings";
import { Text } from "@/ui/text";
import { HostRow } from "./host-row";

/** Lists the visible local and remote hosts in the user's order. */
export function HostsList({
  onOpen,
  onDemo,
  onPair,
}: {
  onOpen: (id: HostId) => void;
  onDemo: () => void;
  onPair: () => void;
}) {
  useHostListUpdates();
  const hosts = useHosts();
  const waitingForNetwork = useHostsWaitingForNetwork(hosts.data ?? []);
  useStatusAnnouncement(waitingForNetwork ? PHONE_OFFLINE_TITLE : null);
  const refresh = useRefreshHosts();
  const { set } = usePhoneSettingsActions();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [retryErrors, setRetryErrors] = useState<HostRetryFailure[]>([]);
  const { visible, onViewableItemsChanged } = useVisibleHosts();
  const { width } = useWindowDimensions();

  async function onRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    setRetryErrors([]);
    try {
      setRetryErrors(
        await refresh(hosts.data?.filter(({ id }) => visible.has(id)) ?? [])
      );
    } finally {
      setRefreshVersion((version) => version + 1);
      setRefreshing(false);
    }
  }

  function tryDemo() {
    set({ removed: [] });
    onDemo();
  }

  return (
    <FlatList<HostRecord>
      className="flex-1 bg-background"
      contentContainerClassName="px-4 pt-2 pb-safe-or-4"
      contentInsetAdjustmentBehavior="automatic"
      accessibilityLabel="Hosts list"
      data={hosts.data}
      keyExtractor={({ id }) => id}
      onViewableItemsChanged={onViewableItemsChanged}
      ItemSeparatorComponent={RowGap}
      renderItem={({ item }) => (
        <RowVisibility.Provider
          // The list gutters are 16 pt each. The card has a border and 12 pt padding.
          value={{
            visible: visible.has(item.id),
            width: width - 2 * (16 + 1 + 12),
            refresh: refreshVersion,
          }}
        >
          <HostRow host={item} onOpen={() => onOpen(item.id)} />
        </RowVisibility.Provider>
      )}
      refreshControl={
        <RefreshControl
          accessibilityLabel="Refresh hosts"
          refreshing={refreshing}
          onRefresh={onRefresh}
        />
      }
      ListHeaderComponent={
        <View className="gap-2">
          {hosts.isPending && <Text role="body">Loading hosts…</Text>}
          {hosts.isError && (
            <Text
              role="body"
              accessibilityRole="alert"
              className="text-destructive!"
            >
              Couldn’t load hosts.{" "}
              {failureReason(hosts.error, "Pull down to try again.")}
            </Text>
          )}
          <RetryErrors failures={retryErrors} />
          {waitingForNetwork && (
            <Text role="body" accessibilityLiveRegion="polite">
              {PHONE_OFFLINE_TITLE}
            </Text>
          )}
          {hosts.isSuccess && hosts.data.length === 0 && (
            <View className="gap-3 py-4">
              <Text role="title">No hosts yet</Text>
              <Text role="body">
                Pair a Mac to view its live metrics and history, or explore the
                demo hosts.
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Add a host"
                onPress={onPair}
                className="min-h-[44px] justify-center rounded-xl bg-primary px-4 py-2 active:opacity-70"
              >
                <Text
                  role="body"
                  className="font-semibold text-primary-foreground"
                >
                  Add a host
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Try demo hosts"
                onPress={tryDemo}
                className="min-h-[44px] justify-center px-4 py-2 active:opacity-70"
              >
                <Text role="body" className="text-link">
                  Try demo hosts
                </Text>
              </Pressable>
            </View>
          )}
          {(waitingForNetwork || retryErrors.length > 0) && <RowGap />}
        </View>
      }
    />
  );
}

function RowGap() {
  return <View className="h-2" />;
}

function RetryErrors({ failures }: { failures: HostRetryFailure[] }) {
  const [first] = failures;
  if (!first) return null;
  const multiple = failures.length > 1;
  return (
    <View className="gap-1">
      <Text role="body" accessibilityRole="alert" className="text-destructive!">
        {multiple
          ? `Couldn't reconnect ${failures.length} hosts`
          : `Couldn't reconnect ${first.displayName}: ${first.reason}`}
      </Text>
      {multiple &&
        failures.map(({ id, displayName, reason }) => (
          <Text key={id} role="caption">{`${displayName}: ${reason}`}</Text>
        ))}
    </View>
  );
}
