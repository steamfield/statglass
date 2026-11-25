import { commandError, errorTone } from "@core/command-error";
import type { HostId, RemoteHostStatus } from "@core/generated/types";
import type { PopoverCard } from "@core/popover/card-order";
import { DAY_MS, HOUR_MS } from "@core/time-grid";
import { Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import {
  HISTORY_MODULES,
  historyReadError,
  isHistoryModule,
  useEvents,
  useHistoryRange,
  useModuleHistory,
  useModuleLiveValues,
} from "@/data/history";
import { useHosts } from "@/data/hosts-list";
import { connectionStatusError, useRemoteStatus } from "@/data/live";
import { offlineLabel } from "@/host/connection-pill";
import { Text } from "@/ui/text";
import { EventsList } from "./events-list";
import { historyChart } from "./history-chart";
import { RangeControl } from "./range-control";
import { ScrubbableChart } from "./scrubbable-chart";

function ModuleLiveValues({
  host,
  module,
}: {
  host: HostId;
  module: PopoverCard;
}) {
  const values = useModuleLiveValues(host, module);
  const { series, format } = HISTORY_MODULES[module];
  if (values.every((value) => value === null)) return null;
  const readings = series.map(({ label }, index) => {
    const formatted = format(values[index] ?? null);
    return series.length === 1 ? formatted : `${label} ${formatted}`;
  });
  return (
    <Text {...{ role: "label" }} className="tabular-nums">
      {`Now ${readings.join(" · ")}`}
    </Text>
  );
}

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
  const [width, setWidth] = useState<number | null>(null);
  const hosts = useHosts();
  const hostName = hosts.data?.find(({ id }) => id === host)?.display_name;
  const range = useHistoryRange(windowMs, remote?.clock_offset_ms ?? 0);
  const history = useModuleHistory(host, module, range, width);
  const events = useEvents(history);
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
  const failure = commandError(history.error)?.kind;
  const retryable =
    failure === "remote_busy" ||
    failure === "remote_unreachable" ||
    failure === "internal";
  const busyRetry = commandError(history.failureReason)?.kind === "remote_busy";
  const loading =
    history.isPending || (history.isFetching && (retryable || busyRetry));

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Stack.Screen options={{ title }} />
      <EventsList events={events} showDate={showDate}>
        <RangeControl value={windowMs} onChange={setWindowMs} />
        <View className="gap-2 rounded-xl border border-border bg-card p-3">
          <ModuleLiveValues host={host} module={module} />
          <View
            testID="history-plot-layout"
            onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
          >
            <ScrubbableChart
              key={windowMs}
              chart={chart}
              sampleCount={sampleCount}
              labels={definitions.map(({ label }) => label)}
              format={format}
              showDate={showDate}
            />
          </View>
          {loading && (
            <Text {...{ role: "label" }} accessibilityLiveRegion="polite">
              Loading history…
            </Text>
          )}
          {history.isError && !loading && (
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
              {historyReadError(history.error, "history", hostName)}
            </Text>
          )}
          {retryable && history.isError && !loading && (
            <Pressable
              accessibilityRole="button"
              className="min-h-[44px] min-w-[44px] justify-center self-start px-2 active:opacity-70"
              onPress={() => void history.refetch()}
            >
              <Text {...{ role: "label" }} className="text-link">
                Retry
              </Text>
            </Pressable>
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
  const remote = status.data;
  if (remote && remote.state !== "connected") {
    return (
      <View className="flex-1 bg-background px-4 py-5">
        <Stack.Screen options={{ title: HISTORY_MODULES[module].title }} />
        <Text {...{ role: "label" }} accessibilityLiveRegion="polite">
          {offlineLabel(remote) ?? "Connecting…"}
        </Text>
      </View>
    );
  }
  return <ModuleHistory host={host} module={module} remote={remote} />;
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
