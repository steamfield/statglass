import type { HostId } from "@core/generated/types";
import type { PopoverCard } from "@core/popover/card-order";
import { HOUR_MS } from "@core/time-grid";
import { Stack, useLocalSearchParams } from "expo-router";
import { View } from "react-native";
import { HISTORY_MODULES, isHistoryModule } from "@/data/history";
import { useHostConnection } from "@/data/hosts";
import { connectionStatusError } from "@/data/live";
import { Text } from "@/ui/text";
import { MODULE_PAGES } from "./pages";

function ModuleHost({ host, module }: { host: HostId; module: PopoverCard }) {
  const status = useHostConnection(host, true);
  // A failed refetch keeps the cached status, so the page (and its range) stays mounted.
  if (status.isPending || status.isLoadingError) {
    return (
      <View className="flex-1 bg-background px-4 py-5">
        <Stack.Screen options={{ title: HISTORY_MODULES[module].title }} />
        <Text
          variant="label"
          accessibilityLiveRegion="polite"
          accessibilityRole={status.isError ? "alert" : undefined}
        >
          {status.isError
            ? connectionStatusError(status.error)
            : "Loading history…"}
        </Text>
      </View>
    );
  }
  const Page = MODULE_PAGES[module];
  return (
    <Page
      host={host}
      module={module}
      range={HOUR_MS}
      remote={status.data?.status}
    />
  );
}

/** The module page for the route's `host` and `module` params. */
export function ModuleScreen() {
  const { host, module } = useLocalSearchParams<{
    host: string;
    module: string;
  }>();
  if (!host || typeof module !== "string" || !isHistoryModule(module)) {
    return (
      <View className="flex-1 bg-background px-4 py-5">
        <Text variant="body">This module isn’t available.</Text>
      </View>
    );
  }
  return <ModuleHost key={`${host}:${module}`} host={host} module={module} />;
}
