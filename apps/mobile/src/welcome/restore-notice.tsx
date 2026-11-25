import { useRouter } from "expo-router";
import type { JSX } from "react";
import { View } from "react-native";
import { GroupedList } from "@/ui/grouped-list";
import { ListRow } from "@/ui/list-row";
import { Text } from "@/ui/text";
import { useRestoreState } from "./use-restore-state";

export function RestoreNotice(): JSX.Element | null {
  const router = useRouter();
  const needsPairing = useRestoreState();

  if (!needsPairing) return null;
  return (
    <View className="pb-2">
      <GroupedList>
        <View className="p-4">
          <Text variant="body">
            This iPhone needs to pair again. Your hosts are still listed, and
            their history is on the hosts, but this phone has a new key after
            the restore.
          </Text>
        </View>
        <ListRow
          title="Pair again"
          accessory="chevron"
          onPress={() => router.push("/pair")}
        />
      </GroupedList>
    </View>
  );
}
