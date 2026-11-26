/** Route a host and module pair to its history page. */
import type { HostId } from "@core/generated/types";
import type { PopoverCard } from "@core/popover/card-order";
import { HOUR_MS } from "@core/time-grid";
import { Stack, useLocalSearchParams } from "expo-router";
import { View } from "react-native";
import { isHistoryModule, MODULE_TITLES } from "@/data/history";
import { useHostConnection } from "@/data/hosts";
import { connectionStatusError } from "@/data/live";
import { ScreenScroll } from "@/ui/screen-scroll";
import { Text } from "@/ui/text";
import { ModuleStatusNotice } from "./module-frame";
import { ModuleNotice } from "./module-notice";
import { MODULE_PAGES } from "./pages";

function ModuleHost({ host, module }: { host: HostId; module: PopoverCard }) {
  const status = useHostConnection(host, true);
  // A failed refetch keeps the cached status, so the page (and its range) stays mounted.
  if (status.isPending || status.isLoadingError) {
    return (
      <ScreenScroll contentContainerClassName="px-4 py-5">
        <Stack.Screen
          options={{
            title: MODULE_TITLES[module],
            headerLargeTitle: false,
          }}
        />
        <ModuleNotice
          message={
            status.isError
              ? connectionStatusError(status.error)
              : "Loading history…"
          }
          error={status.isError}
          onRetry={status.isError ? () => void status.refetch() : undefined}
        />
      </ScreenScroll>
    );
  }
  const Page = MODULE_PAGES[module];
  return (
    <ModuleStatusNotice.Provider
      value={
        status.isRefetchError ? (
          <ModuleNotice
            error
            message={connectionStatusError(status.error)}
            onRetry={() => void status.refetch()}
          />
        ) : null
      }
    >
      <Page host={host} range={HOUR_MS} remote={status.data?.status} />
    </ModuleStatusNotice.Provider>
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
