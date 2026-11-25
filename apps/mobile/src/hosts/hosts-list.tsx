import type { HostId } from "@core/generated/types";
import { failureReason } from "@core/remote-errors";
import { useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import {
  type HostRetryFailure,
  useHostListUpdates,
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
  const refresh = useRefreshHosts();
  const { set } = usePhoneSettingsActions();
  const [refreshing, setRefreshing] = useState(false);
  const [retryErrors, setRetryErrors] = useState<HostRetryFailure[]>([]);

  async function onRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    setRetryErrors([]);
    try {
      setRetryErrors(await refresh(hosts.data ?? []));
    } finally {
      setRefreshing(false);
    }
  }

  function tryDemo() {
    set({ removed: [] });
    onDemo();
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={
        <RefreshControl
          accessibilityLabel="Refresh hosts"
          refreshing={refreshing}
          onRefresh={onRefresh}
        />
      }
    >
      <View className="gap-2 px-4 pt-2 pb-safe-or-4">
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
        {hosts.isSuccess && hosts.data.length === 0 && (
          <View className="gap-3 py-4">
            <Text role="title">No hosts yet</Text>
            <Text role="body">
              Pair a Mac to view its live metrics and history, or explore the
              demo hosts.
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Pair with your Mac"
              onPress={onPair}
              className="min-h-[44px] justify-center rounded-xl bg-primary px-4 py-2 active:opacity-70"
            >
              <Text
                role="body"
                className="font-semibold text-primary-foreground"
              >
                Pair with your Mac
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
        {hosts.data?.map((host) => (
          <HostRow key={host.id} host={host} onOpen={() => onOpen(host.id)} />
        ))}
      </View>
    </ScrollView>
  );
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
