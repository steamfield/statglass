import type {
  HostId,
  OfferedHost,
  UnavailableHostInfo,
} from "@core/generated/types";
import { handoverReasonText } from "@core/remote-errors";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { Text } from "@/ui/text";

export function useHostSelection(hosts: OfferedHost[]) {
  const [excluded, setExcluded] = useState<Set<HostId>>(() => new Set());
  return {
    excluded,
    selected: hosts.filter((host) => !excluded.has(host.id)),
    toggle(id: HostId) {
      setExcluded((previous) => {
        const next = new Set(previous);
        if (!next.delete(id)) next.add(id);
        return next;
      });
    },
  };
}

export function HostChoices({
  hosts,
  excluded,
  disabled,
  toggle,
}: {
  hosts: OfferedHost[];
  excluded: ReadonlySet<HostId>;
  disabled: boolean;
  toggle(id: HostId): void;
}) {
  return hosts.map((host) => {
    const checked = !excluded.has(host.id);
    return (
      <Pressable
        key={host.id}
        accessibilityRole="checkbox"
        accessibilityLabel={host.name}
        accessibilityState={{ checked, disabled }}
        className="min-h-[44px] flex-row items-center gap-3 rounded-xl border border-border bg-card px-4 py-2 active:opacity-70"
        disabled={disabled}
        onPress={() => toggle(host.id)}
      >
        <View
          accessible={false}
          className={`size-6 items-center justify-center rounded-md border ${checked ? "border-primary bg-primary" : "border-muted-foreground"}`}
        >
          {checked && (
            <Text variant="caption" allowFontScaling={false} tone="onPrimary">
              ✓
            </Text>
          )}
        </View>
        <Text variant="body" className="flex-1">
          {host.name}
        </Text>
      </Pressable>
    );
  });
}

export function UnavailableHosts({ hosts }: { hosts: UnavailableHostInfo[] }) {
  if (!hosts.length) return null;
  return (
    <View className="gap-2">
      <Text variant="label">Unavailable</Text>
      {hosts.map(({ id, name, reason }) => (
        <View key={id} className="gap-1">
          <Text variant="body">{name}</Text>
          <Text variant="caption">{handoverReasonText(reason)}</Text>
        </View>
      ))}
    </View>
  );
}
