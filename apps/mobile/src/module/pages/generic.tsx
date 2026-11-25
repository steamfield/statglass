import { commandError, errorTone } from "@core/command-error";
import { formatPercent } from "@core/format";
import type {
  ProcessSort,
  ProcessView,
  SeriesHistoryStats,
} from "@core/generated/types";
import {
  BATTERY_HERO,
  CPU_HERO,
  GPU_HERO,
  memoryUsedHero,
  NETWORK_HERO,
  POWER_HERO,
} from "@core/module-hero";
import type { PopoverCard } from "@core/popover/card-order";
import { FULL_TABLE } from "@core/process-interest";
import { DAY_MS } from "@core/time-grid";
import { useMemo, useState } from "react";
import { View } from "react-native";
import {
  HISTORY_MODULES,
  historyReadError,
  useHistoryRange,
  useModuleHistory,
  useModuleLiveValues,
} from "@/data/history";
import { useHosts } from "@/data/hosts-list";
import { remoteStatusLine } from "@/data/live";
import { LiveProcessTable } from "@/module/live-process-table";
import { type Ceiling, ModuleChart } from "@/module/module-chart";
import { ModuleFrame } from "@/module/module-frame";
import { ModuleNotice } from "@/module/module-notice";
import { StatStrip } from "@/module/stat-strip";
import type { ModulePageProps } from "./index";

const PROCESS_SORTS = {
  cpu: "cpu",
  memory: "memory",
  gpu: "gpu",
  power: "energy",
  network: "net_total",
  battery: "energy",
} satisfies Record<PopoverCard, ProcessSort>;
const NO_STATS: readonly SeriesHistoryStats[] = [];

function LiveStats({
  host,
  module,
  remote,
  stats,
}: Pick<ModulePageProps, "host" | "module" | "remote"> & {
  stats: readonly SeriesHistoryStats[];
}) {
  const values = useModuleLiveValues(host, module, remote);
  const { series, format, ceiling, title } = HISTORY_MODULES[module];
  const [lead, ...items] = series.map(({ key, label }, i) => ({
    label,
    value: format(values[i] ?? null),
    seriesKey: key,
  }));
  const formatAvg =
    ceiling === 100
      ? (value: number) => formatPercent(value, { decimals: 1 })
      : format;
  return (
    <StatStrip
      lead={{
        ...lead,
        label: lead?.label ?? title,
        value: lead?.value ?? format(null),
        format,
        formatAvg,
      }}
      items={items}
      stats={stats}
    />
  );
}

function historyNotice(
  history: ReturnType<typeof useModuleHistory>,
  hostName: string | undefined,
  hasSamples: boolean
) {
  const error = commandError(history.error)?.kind;
  const retryable =
    error === "remote_busy" ||
    error === "remote_unreachable" ||
    error === "internal";
  const retryingBusy =
    commandError(history.failureReason)?.kind === "remote_busy";
  if (
    history.isPending ||
    (history.isFetching && (retryable || retryingBusy))
  ) {
    return <ModuleNotice message="Loading history…" />;
  }
  if (history.isError) {
    return (
      <ModuleNotice
        message={historyReadError(history.error, hostName)}
        error={errorTone(history.error) === "error"}
        onRetry={retryable ? () => void history.refetch() : undefined}
      />
    );
  }
  if (history.isSuccess && !hasSamples)
    return <ModuleNotice message="No samples in this range" />;
  return null;
}

function heroPlot(
  module: PopoverCard,
  values: Record<string, (number | null)[]>,
  memoryBytes: number | undefined
) {
  const { series: definitions, ceiling, format } = HISTORY_MODULES[module];
  if (module === "network") {
    return {
      lines: definitions.map(({ key }, index) => ({
        key,
        values: values[key] ?? [],
        step: index === 0 ? (1 as const) : (2 as const),
      })),
      scale: { min: NETWORK_HERO.chart.minCeiling },
    };
  }
  const spec = {
    cpu: CPU_HERO,
    gpu: GPU_HERO,
    memory: memoryUsedHero(memoryBytes ?? 0, format),
    power: POWER_HERO,
    battery: BATTERY_HERO,
  }[module];
  const scale: Ceiling =
    ceiling ??
    (module === "memory"
      ? memoryBytes || { min: 1, ladder: "binary" }
      : { min: POWER_HERO.yAxis.min });
  return { lines: spec.lines(values), scale };
}

export function GenericModulePage({
  host,
  module,
  range: defaultRange,
  remote,
}: ModulePageProps) {
  const [windowMs, setWindowMs] = useState(defaultRange);
  const [width, setWidth] = useState<number | null>(null);
  const hostRecord = useHosts().data?.find(({ id }) => id === host);
  const info = hostRecord?.info;
  const connected = remote === undefined || remote.state === "connected";
  const clockOffset = remote?.clock_offset_ms ?? 0;
  const range = useHistoryRange(windowMs, clockOffset);
  const history = useModuleHistory(host, module, range, width, connected);
  const { data, displayedRange, grid } = history;
  const {
    title,
    accent,
    series: definitions,
    format,
  } = HISTORY_MODULES[module];
  const view = useMemo<ProcessView>(
    () => ({
      ...FULL_TABLE,
      ...(module === "gpu" && { gpu: true }),
      ...(module === "network" && { network: true }),
    }),
    [module]
  );
  const plot = useMemo(
    () => heroPlot(module, grid?.values ?? {}, info?.mem_total_bytes),
    [module, grid, info?.mem_total_bytes]
  );
  const series = useMemo(
    () =>
      plot.lines.map((line) => ({
        ...line,
        readings: grid?.values[line.key],
        label:
          definitions.find(({ key }) => key === line.key)?.label ?? line.key,
      })),
    [definitions, grid, plot.lines]
  );
  const hasSamples = series.some(({ values }) =>
    values.some((value) => value !== null)
  );
  const events = useMemo(
    () =>
      data?.events.filter(
        ({ ts_ms }) =>
          ts_ms >= displayedRange.fromMs && ts_ms <= displayedRange.toMs
      ),
    [data?.events, displayedRange]
  );
  return (
    <ModuleFrame
      title={title}
      subtitle={info?.chip ?? info?.model ?? null}
      range={windowMs}
      onRange={setWindowMs}
      events={events}
      showDate={windowMs >= DAY_MS}
    >
      {connected ? (
        <>
          <LiveStats
            host={host}
            module={module}
            remote={remote}
            stats={data?.stats ?? NO_STATS}
          />
          <View
            className="gap-2 rounded-xl border border-border bg-card p-3"
            testID="history-plot-layout"
            onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
          >
            <ModuleChart
              key={windowMs}
              series={series}
              gaps={data?.gaps ?? []}
              ceiling={plot.scale}
              format={format}
              range={displayedRange}
              nowMs={Math.max(displayedRange.toMs, range.toMs)}
              events={events ?? []}
              clockOffsetMs={clockOffset}
              height={160}
              accent={accent}
              module={module}
              label={`${title} history`}
              grid={grid}
              loading={history.isPending}
            />
            {historyNotice(history, hostRecord?.display_name, hasSamples)}
          </View>
        </>
      ) : (
        <ModuleNotice
          message={remoteStatusLine(remote)?.label ?? "Reconnecting"}
        />
      )}
      <LiveProcessTable host={host} sort={PROCESS_SORTS[module]} view={view} />
    </ModuleFrame>
  );
}
