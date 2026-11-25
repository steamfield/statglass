import { commandError, errorTone } from "@core/command-error";
import {
  formatBytes,
  formatMarketingMemory,
  formatPercent,
} from "@core/format";
import type {
  Event,
  Gap,
  HostInfo,
  SeriesHistoryStats,
} from "@core/generated/types";
import { historyGrid } from "@core/history-grid";
import { currentLayout, keysOf } from "@core/live-selectors";
import { MEMORY_PRESSURE_HERO, memoryUsedHero } from "@core/module-hero";
import { FULL_TABLE } from "@core/process-interest";
import { DAY_MS } from "@core/time-grid";
import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { useFocusDemand } from "@/data/demand";
import {
  type HistoryRange,
  historyReadError,
  useHistoryRange,
  useHostHistory,
} from "@/data/history";
import { useHosts } from "@/data/hosts-list";
import {
  remoteStatusLine,
  useConnection,
  useHostLive,
  useHostLiveSubscription,
} from "@/data/live";
import { LiveProcessTable } from "@/module/live-process-table";
import { ModuleChart } from "@/module/module-chart";
import { ModuleFrame } from "@/module/module-frame";
import { ModuleNotice } from "@/module/module-notice";
import type { ModulePageProps } from "@/module/pages/index";
import { Text } from "@/ui/text";
import { MemoryComposition, SwapStats } from "./live-stats";

const MEMORY_KEYS = ["mem.pressure", "mem.used", "mem.cached", "mem.swap_used"];
const SELECTORS = MEMORY_KEYS.map((metric) => ({ metric, labels: [] }));
const NO_EVENTS: readonly Event[] = [];
const NO_STATS: readonly SeriesHistoryStats[] = [];
const NO_GAPS: readonly Gap[] = [];
const MEMORY_LABELS: Record<string, string> = {
  "mem.cached": "Cached files",
  "mem.used": "Used",
  "mem.pressure": "Pressure",
};

function MemoryHistoryNotice({
  history,
  hostName,
  hasSamples,
}: {
  history: ReturnType<typeof useHostHistory>;
  hostName: string | undefined;
  hasSamples: boolean;
}) {
  const kind = commandError(history.error)?.kind;
  const retryable =
    kind === "remote_busy" ||
    kind === "remote_unreachable" ||
    kind === "internal";
  const retryingBusy =
    commandError(history.failureReason)?.kind === "remote_busy";
  if (history.isPending || (history.isFetching && (retryable || retryingBusy)))
    return <ModuleNotice message="Loading history…" />;
  if (history.isError)
    return (
      <ModuleNotice
        message={historyReadError(history.error, hostName)}
        error={errorTone(history.error) === "error"}
        onRetry={retryable ? () => void history.refetch() : undefined}
      />
    );
  return hasSamples ? null : (
    <ModuleNotice message="No samples in this range" />
  );
}

function useMemoryHistory(
  host: ModulePageProps["host"],
  range: HistoryRange,
  width: number | null,
  connected: boolean
) {
  const history = useHostHistory(
    host,
    SELECTORS,
    range,
    width,
    "memory",
    connected
  );
  const windowMs = range.toMs - range.fromMs;
  const previousWindow = useRef(windowMs);
  const { isEnabled, isSuccess, isFetching, refetch } = history;
  useEffect(() => {
    const changed = previousWindow.current !== windowMs;
    previousWindow.current = windowMs;
    // A new range fetches on its own. Reopening a cached range also refreshes it.
    if (changed && isEnabled && isSuccess && !isFetching)
      void refetch({ cancelRefetch: false });
  }, [isEnabled, isSuccess, isFetching, refetch, windowMs]);
  const page = connected ? history.data?.page : undefined;
  const displayedRange = history.data?.range ?? range;
  const grid = useMemo(
    () =>
      page
        ? historyGrid(
            page,
            MEMORY_KEYS,
            displayedRange.fromMs,
            displayedRange.toMs
          )
        : null,
    [page, displayedRange]
  );
  const events = useMemo(
    () =>
      page?.events.filter(
        ({ ts_ms }) =>
          ts_ms >= displayedRange.fromMs && ts_ms <= displayedRange.toMs
      ),
    [page, displayedRange]
  );
  return { history, page, grid, displayedRange, events };
}

function memorySubtitle(info: HostInfo | undefined) {
  if (!info) return null;
  return info.os === "mac_os"
    ? `${formatMarketingMemory(info.mem_total_bytes)} unified`
    : formatBytes(info.mem_total_bytes);
}

function usePressureReported(host: ModulePageProps["host"]) {
  return useHostLive(host, (state) =>
    currentLayout(state) === null
      ? null
      : keysOf(state, "mem.pressure").length > 0
  );
}

export function MemoryPage({
  host,
  range: defaultRange,
  remote,
}: ModulePageProps) {
  const [windowMs, setWindowMs] = useState(defaultRange);
  const [width, setWidth] = useState<number | null>(null);
  const record = useHosts().data?.find(({ id }) => id === host);
  const total = record?.info.mem_total_bytes ?? null;
  const connected = remote === undefined || remote.state === "connected";
  const connection = useConnection(host, remote, null);
  const live = connection.state === "live";
  const clockOffsetMs = remote?.clock_offset_ms ?? 0;
  const range = useHistoryRange(windowMs, clockOffsetMs);
  useHostLiveSubscription(host);
  useFocusDemand(host, "full");
  const data = useMemoryHistory(host, range, width, connected);
  return (
    <ModuleFrame
      title="Memory"
      subtitle={memorySubtitle(record?.info)}
      range={windowMs}
      onRange={setWindowMs}
      events={data.events}
      showDate={windowMs >= DAY_MS}
    >
      {connected ? (
        <>
          {connection.state === "reconnecting" && (
            <ModuleNotice message={connection.label} />
          )}
          <MemoryComposition
            host={host}
            live={live}
            total={total}
            stats={data.page?.stats ?? NO_STATS}
          />
          <MemoryCharts
            key={windowMs}
            host={host}
            remote={remote}
            live={live}
            hostName={record?.display_name}
            total={total}
            data={data}
            nowMs={range.toMs}
            onWidth={setWidth}
          />
        </>
      ) : (
        <ModuleNotice
          message={remoteStatusLine(remote)?.label ?? "Reconnecting"}
        />
      )}
      <LiveProcessTable host={host} sort="memory" view={FULL_TABLE} />
    </ModuleFrame>
  );
}

function MemoryCharts({
  host,
  remote,
  live,
  hostName,
  total,
  data: { history, page, grid, displayedRange, events },
  nowMs,
  onWidth,
}: Pick<ModulePageProps, "host" | "remote"> & {
  hostName: string | undefined;
  live: boolean;
  total: number | null;
  data: ReturnType<typeof useMemoryHistory>;
  nowMs: number;
  onWidth(width: number): void;
}) {
  const pressureReported = usePressureReported(host);
  const pressure =
    pressureReported ??
    page?.series.some(({ key }) => key.metric === "mem.pressure") === true;
  const plot = pressure
    ? MEMORY_PRESSURE_HERO
    : memoryUsedHero(total ?? 0, formatBytes);
  const series = plot.lines(grid?.values ?? {}).map((line) => ({
    ...line,
    label: MEMORY_LABELS[line.key] ?? line.key,
    readings: grid?.values[line.key],
  }));
  const hasSamples = series.some(({ values }) =>
    values.some((value) => value !== null)
  );
  const swap = grid?.values["mem.swap_used"] ?? [];
  const hasSwapSamples = swap.some((value) => value !== null);
  const chart = {
    gaps: page?.gaps ?? NO_GAPS,
    range: displayedRange,
    nowMs: Math.max(nowMs, displayedRange.toMs),
    grid,
    clockOffsetMs: remote?.clock_offset_ms ?? 0,
    loading: history.isPending,
    module: "memory",
    accent: "mem",
  } as const;
  return (
    <>
      <View
        className="gap-2 rounded-xl border border-border bg-card p-3"
        testID="history-plot-layout"
        onLayout={({ nativeEvent }) => onWidth(nativeEvent.layout.width)}
      >
        <Text variant="cardTitle" accessibilityRole="header">
          {pressure ? "Pressure" : "Used and cached memory"}
        </Text>
        <ModuleChart
          {...chart}
          series={hasSamples ? series : []}
          ceiling={pressure ? 100 : total || { min: 1 }}
          format={pressure ? formatPercent : formatBytes}
          events={events ?? NO_EVENTS}
          height={160}
          label={plot.subject}
        />
        <MemoryHistoryNotice
          history={history}
          hostName={hostName}
          hasSamples={hasSamples}
        />
      </View>
      <View className="gap-2 rounded-xl border border-border bg-card p-3">
        <Text variant="cardTitle" accessibilityRole="header">
          Swap
        </Text>
        <SwapStats host={host} live={live} />
        <ModuleChart
          {...chart}
          series={
            hasSwapSamples
              ? [{ key: "mem.swap_used", label: "Used", step: 1, values: swap }]
              : []
          }
          ceiling={{ min: 100e6 }}
          format={formatBytes}
          events={NO_EVENTS}
          height={110}
          label="Swap used"
        />
        {history.isSuccess && !hasSwapSamples && (
          <ModuleNotice message="No swap samples in this range" />
        )}
      </View>
    </>
  );
}
