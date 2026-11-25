import type { HostId, HostRecord } from "@core/generated/types";
import { failureReason } from "@core/remote-errors";
import { useNavigation, useRouter } from "expo-router";
import { useState } from "react";
import { TextInput } from "react-native";
import { useHostListUpdates, useHostStatus } from "@/data/hosts";
import { useHosts } from "@/data/hosts-list";
import { usePhoneSettingsActions } from "@/data/phone-settings";
import { GroupedList, ListSection } from "@/ui/grouped-list";
import { ListRow } from "@/ui/list-row";
import { RetryPanel } from "@/ui/retry-panel";
import { Text } from "@/ui/text";
import { useThemeColors } from "@/ui/theme-colors";
import { useHostRemoval } from "./host-removal";
import { SettingsScroll } from "./settings-scroll";

export function HostDetailSettings({ host }: { host: HostId }) {
  useHostListUpdates();
  const hosts = useHosts();
  const record = hosts.data?.find(({ id }) => id === host);
  return (
    <SettingsScroll
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      {record ? (
        <HostDetails key={record.id} host={record} />
      ) : hosts.isError ? (
        <RetryPanel
          title="Couldn’t load hosts"
          detail={failureReason(hosts.error, "Try again.")}
          retry={() => void hosts.refetch()}
        />
      ) : (
        <Text variant="body">
          {hosts.isPending
            ? "Loading host…"
            : "This host is no longer on this iPhone."}
        </Text>
      )}
    </SettingsScroll>
  );
}

function HostDetails({ host }: { host: HostRecord }) {
  const router = useRouter();
  const navigation = useNavigation();
  const confirm = useHostRemoval();

  function closeRemovedHost() {
    if (!navigation.isFocused()) return;
    if (router.canGoBack()) router.back();
    else router.replace("/settings/hosts");
  }

  return (
    <>
      <RenameHost key={host.display_name} host={host} />
      <HostRoutes host={host.id} />
      <GroupedList>
        <ListRow
          title="Re-pair"
          accessory="chevron"
          onPress={() => router.push("/pair")}
        />
        <ListRow
          title="Update from Mac"
          accessory="chevron"
          onPress={() => router.push("/update-from-mac")}
        />
      </GroupedList>
      <GroupedList>
        <ListRow
          title="Remove"
          destructive
          onPress={() => confirm(host, closeRemovedHost)}
        />
      </GroupedList>
    </>
  );
}

function RenameHost({ host }: { host: HostRecord }) {
  const [name, setName] = useState(host.display_name);
  const [invalid, setInvalid] = useState(false);
  const { set } = usePhoneSettingsActions();
  const colors = useThemeColors();

  function save() {
    const trimmed = name.trim();
    if (!trimmed || [...trimmed].length > 64) {
      setInvalid(true);
      return;
    }
    setName(trimmed);
    set(({ hostNames }) => ({
      hostNames: { ...hostNames, [host.id]: trimmed },
    }));
  }

  return (
    <ListSection title="Rename">
      <GroupedList>
        <TextInput
          accessibilityLabel="Name on this iPhone"
          value={name}
          onChangeText={(text) => {
            setName(text);
            setInvalid(false);
          }}
          onSubmitEditing={save}
          returnKeyType="done"
          placeholder="Name on this iPhone"
          placeholderTextColor={colors["muted-foreground"]}
          className="min-h-[44px] px-4 py-2 text-[17px] text-foreground"
        />
      </GroupedList>
      {invalid && (
        <Text variant="caption" accessibilityRole="alert" className="px-4">
          Enter a name between 1 and 64 characters.
        </Text>
      )}
    </ListSection>
  );
}

function HostRoutes({ host }: { host: HostId }) {
  const routes = useHostStatus(host);
  const config = routes.data?.config;
  return (
    <ListSection title="Routes">
      {routes.isError ? (
        <RetryPanel
          title="Couldn’t load routes"
          detail={failureReason(routes.error, "Try again.")}
          retry={() => void routes.refetch()}
        />
      ) : (
        <GroupedList>
          {config ? (
            <>
              <ListRow title="LAN" value={config.lan ?? "Not set"} />
              <ListRow
                title="Tailscale"
                value={config.tailscale ?? "Not set"}
              />
            </>
          ) : (
            <ListRow
              title={
                routes.isPending ? "Loading routes…" : "No routes available."
              }
            />
          )}
        </GroupedList>
      )}
    </ListSection>
  );
}
