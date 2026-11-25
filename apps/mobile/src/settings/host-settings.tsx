import type { HostRecord, OsKind } from "@core/generated/types";
import { hostStatusSummary } from "@core/phone-connection";
import { failureReason } from "@core/remote-errors";
import { useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";
import { ScrollViewContainer } from "react-native-reorderable-list";
import {
  useControllerRemovedHosts,
  useHostListUpdates,
  useHostStatus,
} from "@/data/hosts";
import { useHosts } from "@/data/hosts-list";
import { usePhoneSettingsActions } from "@/data/phone-settings";
import { GroupedList } from "@/ui/grouped-list";
import type { IconName } from "@/ui/icons";
import { ListRow } from "@/ui/list-row";
import { ReorderList } from "@/ui/reorder-list";
import { RetryPanel } from "@/ui/retry-panel";
import { SwipeRow } from "@/ui/swipe-row";
import { Text } from "@/ui/text";
import { useThemeColors } from "@/ui/theme-colors";
import { useHostRemoval } from "./host-removal";
import { useSettingsEscape } from "./settings-scroll";

const OS: Record<OsKind, { glyph: IconName; label: string }> = {
  mac_os: { glyph: "apple.logo", label: "macOS" },
  linux: { glyph: "server.rack", label: "Linux" },
  unknown: { glyph: "server.rack", label: "Unknown OS" },
};

export function HostSettings() {
  const router = useRouter();
  const colors = useThemeColors();
  const escapeProps = useSettingsEscape();
  useHostListUpdates();
  const hosts = useHosts();
  const hasHosts = !!hosts.data?.length;
  const removedOnMac = useControllerRemovedHosts(hasHosts);
  const { set } = usePhoneSettingsActions();
  const confirm = useHostRemoval();

  return (
    // The reorderable rows need the outer scroll view for edge autoscroll.
    <ScrollViewContainer
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: colors.background }}
      {...escapeProps}
    >
      <View className="gap-3 px-4 pt-2 pb-safe-or-4">
        {hosts.isError && (
          <RetryPanel
            title="Couldn’t load hosts"
            detail={failureReason(hosts.error, "Try again.")}
            retry={() => void hosts.refetch()}
          />
        )}
        {hosts.isPending && <Text variant="body">Loading hosts…</Text>}
        {hasHosts && removedOnMac.isError && (
          <RetryPanel
            title="Couldn’t load connection statuses"
            detail={failureReason(removedOnMac.error, "Try again.")}
            retry={() => void removedOnMac.refetch()}
          />
        )}
        {hosts.isSuccess && hosts.data.length === 0 && (
          <Text variant="body">No hosts on this iPhone.</Text>
        )}
        {hosts.data && hasHosts && (
          <GroupedList>
            <ReorderList
              data={hosts.data}
              keyOf={(host) => host.id}
              itemLabel={(host) => `Reorder ${host.display_name}`}
              nested
              onReorder={(hostOrder) => set({ hostOrder })}
              renderItem={({ item, index }) => (
                <View
                  style={
                    index === 0
                      ? undefined
                      : {
                          borderColor: colors["border-subtle"],
                          borderTopWidth: StyleSheet.hairlineWidth,
                        }
                  }
                >
                  <SwipeRow actionLabel="Remove" onAction={() => confirm(item)}>
                    <HostRow
                      host={item}
                      removedOnMac={
                        removedOnMac.data?.includes(item.id) ?? false
                      }
                      onOpen={() =>
                        router.push({
                          pathname: "/settings/host/[host]",
                          params: { host: item.id },
                        })
                      }
                    />
                  </SwipeRow>
                </View>
              )}
            />
          </GroupedList>
        )}
        <GroupedList>
          <ListRow
            title="Add a host"
            accessory="chevron"
            onPress={() => router.push("/pair")}
          />
          <ListRow
            title="Update from Mac"
            accessory="chevron"
            onPress={() => router.push("/update-from-mac")}
          />
        </GroupedList>
      </View>
    </ScrollViewContainer>
  );
}

function HostRow({
  host,
  removedOnMac,
  onOpen,
}: {
  host: HostRecord;
  removedOnMac: boolean;
  onOpen(): void;
}) {
  const status = useHostStatus(host.id);
  const remote = status.isError ? null : (status.data?.status ?? null);
  const summary = hostStatusSummary(remote, { nowMs: Date.now() });
  const label = host.is_local
    ? "Live"
    : status.isPending
      ? "Loading status…"
      : summary.label;
  const subtitle = removedOnMac ? `${label} · Removed on your Mac` : label;
  const platform = OS[host.info.os];
  return (
    <ListRow
      title={host.display_name}
      subtitle={subtitle}
      glyph={platform.glyph}
      accessory="chevron"
      accessibilityHint={platform.label}
      onPress={onOpen}
    />
  );
}
