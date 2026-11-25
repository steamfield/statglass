import { formatPercent, formatWatts } from "@core/format";
import { historyGrid } from "@core/history-grid";
import type { HostLive } from "@core/live-state";
import { GPU_HERO } from "@core/module-hero";
import { moduleState, unavailableText } from "@core/module-state";
import { FULL_TABLE } from "@core/process-interest";
import { DAY_MS } from "@core/time-grid";
import { useMemo, useState } from "react";
import { View } from "react-native";
import { useFocusDemand } from "@/data/demand";
import { useHistoryRange, useHostHistory } from "@/data/history";
import { useHosts } from "@/data/hosts-list";
import {
  remoteStatusLine,
  useConnection,
  useHostLive,
  useHostLiveSubscription,
} from "@/data/live";
import {
  HistoryNotice,
  useRefreshOnRangeChange,
} from "@/module/history-notice";
import { LiveProcessTable } from "@/module/live-process-table";
import { ModuleChart } from "@/module/module-chart";
import { ModuleFrame } from "@/module/module-frame";
import { ModuleNotice } from "@/module/module-notice";
import type { ModulePageProps } from "@/module/pages/index";
import { Text } from "@/ui/text";
import { Frequency } from "./frequency";
import { GpuStats } from "./stats";

const powerKey = "power.gpu";
const plotKeys = [...GPU_HERO.keys, powerKey];
const selection = [...plotKeys, "gpu.residency"].map((metric) => ({
  metric,
  labels: [],
}));
const processView = { ...FULL_TABLE, gpu: true };
const powerCeiling = { min: 1 };

function GpuLiveStream({ host }: Pick<ModulePageProps, "host">) {
  useHostLiveSubscription(host);
  return null;
}

function gpuUnavailable({ capabilities }: HostLive) {
  if (capabilities === null) return undefined;
  const state = moduleState(capabilities, null, "gpu");
  if (state === "on") return null;
  return unavailableText(
    state === "unknown_chip" ? "unavailable" : state,
    "host"
  );
}

function gpuReadState(
  remote: ModulePageProps["remote"],
  unavailable: ReturnType<typeof gpuUnavailable>,
  connection: ReturnType<typeof useConnection>
) {
  if (remote && remote.state !== "connected") {
    return {
      connected: false,
      available: false,
      notice: remoteStatusLine(remote)?.label ?? "Reconnecting",
    };
  }
  if (unavailable)
    return { connected: true, available: false, notice: unavailable };
  const liveIssue =
    connection.state !== "live" && connection.label !== "Connecting"
      ? connection.label
      : null;
  const available = unavailable === null || liveIssue !== null;
  return {
    connected: true,
    available,
    notice: available ? liveIssue : "Connecting to host…",
  };
}

export function GpuPage({
  host,
  range: defaultRange,
  remote,
}: ModulePageProps) {
  const [windowMs, setWindowMs] = useState(defaultRange);
  const [width, setWidth] = useState<number | null>(null);
  const record = useHosts().data?.find(({ id }) => id === host);
  const clockOffset = remote?.clock_offset_ms ?? 0;
  const range = useHistoryRange(windowMs, clockOffset);
  useFocusDemand(host, "full");
  const unavailable = useHostLive(host, gpuUnavailable);
  const connection = useConnection(host, remote, null);
  const { connected, available, notice } = gpuReadState(
    remote,
    unavailable,
    connection
  );
  const history = useHostHistory(
    host,
    selection,
    range,
    width,
    "gpu",
    available
  );
  useRefreshOnRangeChange(windowMs, history);
  const data = available ? history.data : undefined;
  const displayedRange = data?.range ?? range;
  const grid = useMemo(
    () =>
      data
        ? historyGrid(data.page, plotKeys, data.range.fromMs, data.range.toMs)
        : null,
    [data]
  );
  const utilization = useMemo(
    () =>
      GPU_HERO.lines(grid?.values ?? {}).map((line) => ({
        ...line,
        label: "Utilization",
      })),
    [grid]
  );
  const power = useMemo(
    () => [
      {
        key: powerKey,
        label: "Power",
        values: grid?.values[powerKey] ?? [],
        step: 1 as const,
      },
    ],
    [grid]
  );
  const events = useMemo(
    () =>
      data?.page.events.filter(
        ({ ts_ms }) =>
          ts_ms >= displayedRange.fromMs && ts_ms <= displayedRange.toMs
      ),
    [data, displayedRange]
  );
  const powerMissing =
    history.isSuccess &&
    !grid?.values[powerKey]?.some((value) => value !== null);
  const chart = {
    gaps: data?.page.gaps ?? [],
    range: displayedRange,
    nowMs: Math.max(displayedRange.toMs, range.toMs),
    events: events ?? [],
    clockOffsetMs: clockOffset,
    accent: "gpu",
    grid,
    loading: history.isPending,
  } as const;

  return (
    <>
      {connected && <GpuLiveStream host={host} />}
      <ModuleFrame
        title="GPU"
        subtitle={record?.info.chip ?? null}
        range={windowMs}
        onRange={setWindowMs}
        events={events}
        {...(available ? { showDate: windowMs >= DAY_MS } : {})}
      >
        {notice && <ModuleNotice message={notice} />}
        {available && (
          <>
            <GpuStats host={host} remote={remote} stats={data?.page.stats} />
            <View
              className="gap-2 rounded-xl border border-border bg-card p-3"
              testID="history-plot-layout"
              onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
            >
              <ModuleChart
                {...chart}
                key={windowMs}
                series={utilization}
                ceiling={100}
                format={formatPercent}
                height={160}
                module="gpu"
                label="GPU history"
              />
              <HistoryNotice
                query={history}
                hostName={record?.display_name}
                hasSamples={utilization.some(({ values }) =>
                  values.some((value) => value !== null)
                )}
              />
            </View>
            <Frequency
              host={host}
              remote={remote}
              dvfsMhz={record?.info.gpu_dvfs_mhz}
              stats={data?.page.stats}
              windowMs={windowMs}
            />
            <View className="gap-2 rounded-xl border border-border bg-card p-3">
              <Text variant="cardTitle" accessibilityRole="header">
                Power
              </Text>
              <ModuleChart
                {...chart}
                key={windowMs}
                events={[]}
                series={power}
                ceiling={powerCeiling}
                format={formatWatts}
                height={140}
                module="power"
                label="GPU power"
              />
              {powerMissing && (
                <ModuleNotice message="No power samples in this range" />
              )}
            </View>
          </>
        )}
        {available && (
          <LiveProcessTable host={host} sort="gpu" view={processView} />
        )}
      </ModuleFrame>
    </>
  );
}
