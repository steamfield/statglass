/** Memory composition, pressure and swap for a host. */
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
import { currentLayout, keysOf } from "@core/live-selectors";
import { MEMORY_PRESSURE_HERO, memoryUsedHero } from "@core/module-hero";
import { FULL_TABLE } from "@core/process-interest";
import { DAY_MS } from "@core/time-grid";
import { type ModuleRead, useModuleHistory } from "@/data/history";
import {
  remoteStatusLine,
  useHostLive,
  useHostLiveSubscription,
} from "@/data/live";
import { HistoryNotice } from "@/module/history-notice";
import { LiveProcessTable } from "@/module/live-process-table";
import { ModuleChart } from "@/module/module-chart";
import { ModuleFrame } from "@/module/module-frame";
import { ModuleNotice } from "@/module/module-notice";
import type { ModulePageProps } from "@/module/pages/index";
import { useModulePage } from "@/module/use-module-page";
import { Card } from "@/ui/card";
import { Text } from "@/ui/text";
import { MemoryComposition, SwapStats } from "./live-stats";

const MEMORY_KEYS = ["mem.pressure", "mem.used", "mem.cached", "mem.swap_used"];
const MEMORY_READ: ModuleRead = {
  module: "memory",
  selection: MEMORY_KEYS.map((metric) => ({ metric, labels: [] })),
  gridKeys: MEMORY_KEYS,
};
const NO_EVENTS: readonly Event[] = [];
const NO_STATS: readonly SeriesHistoryStats[] = [];
const NO_GAPS: readonly Gap[] = [];
const MEMORY_LABELS: Record<string, string> = {
  "mem.cached": "Cached files",
  "mem.used": "Used",
  "mem.pressure": "Pressure",
};

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

/** Render the host's memory history and current composition. */
export function MemoryPage({
  host,
  range: defaultRange,
  remote,
}: ModulePageProps) {
  const {
    windowMs,
    setWindowMs,
    width,
    setWidth,
    record,
    connected,
    connection,
    live,
    range,
  } = useModulePage(host, remote, defaultRange);
  const total = record?.info.mem_total_bytes ?? null;
  useHostLiveSubscription(host);
  const history = useModuleHistory(host, MEMORY_READ, range, width, connected);
  return (
    <ModuleFrame
      title="Memory"
      subtitle={memorySubtitle(record?.info)}
      range={windowMs}
      onRange={setWindowMs}
      events={history.events}
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
            stats={history.data?.stats ?? NO_STATS}
          />
          <MemoryCharts
            key={windowMs}
            host={host}
            clockOffsetMs={range.offsetMs}
            live={live}
            hostName={record?.display_name}
            total={total}
            history={history}
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
  clockOffsetMs,
  live,
  hostName,
  total,
  history,
  nowMs,
  onWidth,
}: Pick<ModulePageProps, "host"> & {
  clockOffsetMs: number;
  hostName: string | undefined;
  live: boolean;
  total: number | null;
  history: ReturnType<typeof useModuleHistory>;
  nowMs: number;
  onWidth(width: number): void;
}) {
  const { data: page, grid, displayedRange, events } = history;
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
    clockOffsetMs,
    loading: history.isPending,
    module: "memory",
    accent: "mem",
  } as const;
  return (
    <>
      <Card
        className="gap-2"
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
        <HistoryNotice
          query={history}
          hostName={hostName}
          hasSamples={hasSamples}
        />
      </Card>
      <Card className="gap-2">
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
      </Card>
    </>
  );
}
