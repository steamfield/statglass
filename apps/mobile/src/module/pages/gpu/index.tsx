/** GPU utilization, frequency and power for a host. */
import { formatPercent, formatWatts } from "@core/format";
import type { HostLive } from "@core/live-state";
import { GPU_HERO } from "@core/module-hero";
import { moduleState, unavailableText } from "@core/module-state";
import { FULL_TABLE } from "@core/process-interest";
import { DAY_MS } from "@core/time-grid";
import { useMemo } from "react";
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
import { type ModulePage, useModulePage } from "@/module/use-module-page";
import { Card } from "@/ui/card";
import { Text } from "@/ui/text";
import { Frequency } from "./frequency";
import { GpuStats } from "./stats";

const powerKey = "power.gpu";
const plotKeys = [...GPU_HERO.keys, powerKey];
const GPU_READ: ModuleRead = {
  module: "gpu",
  selection: [...plotKeys, "gpu.residency"].map((metric) => ({
    metric,
    labels: [],
  })),
  gridKeys: plotKeys,
};
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
  { connected, connection }: Pick<ModulePage, "connected" | "connection">
) {
  if (!connected) {
    return {
      available: false,
      notice: remoteStatusLine(remote)?.label ?? "Reconnecting",
    };
  }
  if (unavailable) return { available: false, notice: unavailable };
  const liveIssue =
    connection.state !== "live" && connection.label !== "Connecting"
      ? connection.label
      : null;
  // A connected session can still be waiting for GPU capabilities.
  const available = unavailable === null || liveIssue !== null;
  return {
    available,
    notice: available ? liveIssue : "Connecting to host…",
  };
}

/** Render the host's GPU history when its capabilities allow it. */
export function GpuPage({
  host,
  range: defaultRange,
  remote,
}: ModulePageProps) {
  const page = useModulePage(host, remote, defaultRange);
  const { windowMs, setWindowMs, width, setWidth, record, connected, range } =
    page;
  const unavailable = useHostLive(host, gpuUnavailable);
  const { available, notice } = gpuReadState(remote, unavailable, page);
  const history = useModuleHistory(host, GPU_READ, range, width, available);
  const { data, displayedRange, grid, events } = history;
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
  const powerMissing =
    history.isSuccess &&
    !grid?.values[powerKey]?.some((value) => value !== null);
  const chart = {
    gaps: data?.gaps ?? [],
    range: displayedRange,
    nowMs: Math.max(displayedRange.toMs, range.toMs),
    events: events ?? [],
    clockOffsetMs: range.offsetMs,
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
            <GpuStats host={host} remote={remote} stats={data?.stats} />
            <Card
              className="gap-2"
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
            </Card>
            <Frequency
              host={host}
              remote={remote}
              dvfsMhz={record?.info.gpu_dvfs_mhz}
              stats={data?.stats}
              windowMs={windowMs}
            />
            <Card className="gap-2">
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
            </Card>
          </>
        )}
        {available && (
          <LiveProcessTable host={host} sort="gpu" view={processView} />
        )}
      </ModuleFrame>
    </>
  );
}
