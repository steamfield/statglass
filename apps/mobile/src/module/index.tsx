import { errorTone } from "@core/command-error";
import { formatDateTime } from "@core/format";
import type { HostId, RemoteHostStatus } from "@core/generated/types";
import type { PopoverCard } from "@core/popover/card-order";
import { DAY_MS, HOUR_MS } from "@core/time-grid";
import { Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import {
  HISTORY_MODULES,
  historyReadError,
  isHistoryModule,
  useEvents,
  useHistoryRange,
  useModuleHistory,
} from "@/data/history";
import { connectionStatusError, useRemoteStatus } from "@/data/live";
import { offlineLabel } from "@/host/connection-pill";
import { Text } from "@/ui/text";
import { EventsList } from "./events-list";
import { historyChart } from "./history-chart";
import { RangeControl } from "./range-control";
import { ScrubbableChart } from "./scrubbable-chart";

function ModuleHistory({
  host,
  module,
  remote,
}: {
  host: HostId;
  module: PopoverCard;
  remote: RemoteHostStatus | undefined;
}) {
  const [windowMs, setWindowMs] = useState(HOUR_MS);
  const offline = offlineLabel(remote);
  const syncedThrough = offline ? (remote?.synced_through_ms ?? null) : null;
  const range = useHistoryRange(
    windowMs,
    remote?.clock_offset_ms ?? 0,
    syncedThrough
  );
  const history = useModuleHistory(host, module, range);
  const events = useEvents(host, range.fromMs, range.toMs);
  const { title, series: definitions, format } = HISTORY_MODULES[module];
  const { data, displayedRange, grid, isPending } = history;
  const { chart, sampleCount } = useMemo(
    () =>
      historyChart(
        module,
        displayedRange,
        { data, grid, isPending },
        events.data
      ),
    [data, displayedRange, events.data, grid, isPending, module]
  );
  const hasSamples = chart.series.some(({ values }) =>
    values.some((value) => value !== null)
  );
  const showDate = windowMs >= DAY_MS;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Stack.Screen options={{ title }} />
      <EventsList events={events} showDate={showDate}>
        <RangeControl value={windowMs} onChange={setWindowMs} />
        {offline && (
          <View className="gap-1">
            <Text {...{ role: "label" }} accessibilityLiveRegion="polite">
              {offline}
            </Text>
            {syncedThrough !== null && (
              <Text {...{ role: "caption" }}>
                Last synced through {formatDateTime(syncedThrough)}
              </Text>
            )}
          </View>
        )}
        <View className="gap-2 rounded-xl border border-border bg-card p-3">
          <ScrubbableChart
            key={windowMs}
            chart={chart}
            sampleCount={sampleCount}
            labels={definitions.map(({ label }) => label)}
            format={format}
            showDate={showDate}
          />
          {history.isPending && (
            <Text {...{ role: "label" }} accessibilityLiveRegion="polite">
              Loading history…
            </Text>
          )}
          {history.isError && (
            <Text
              {...{ role: "label" }}
              accessibilityLiveRegion="polite"
              accessibilityRole={
                errorTone(history.error) === "error" ? "alert" : undefined
              }
              className={
                errorTone(history.error) === "error" ? "text-destructive" : ""
              }
            >
              {historyReadError(history.error, "history")}
            </Text>
          )}
          {history.isSuccess && !hasSamples && (
            <Text {...{ role: "label" }} accessibilityLiveRegion="polite">
              No samples in this range
            </Text>
          )}
        </View>
      </EventsList>
    </GestureHandlerRootView>
  );
}

function ModuleHost({ host, module }: { host: HostId; module: PopoverCard }) {
  const status = useRemoteStatus(host);
  if (status.isPending || status.isError) {
    return (
      <View className="flex-1 bg-background px-4 py-5">
        <Stack.Screen options={{ title: HISTORY_MODULES[module].title }} />
        <Text
          {...{ role: "label" }}
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
  return <ModuleHistory host={host} module={module} remote={status.data} />;
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
        <Text {...{ role: "body" }}>This module isn’t available.</Text>
      </View>
    );
  }
  return <ModuleHost key={`${host}:${module}`} host={host} module={module} />;
}
