/** CPU readings, history and per-core load for a host. */
import { commandErrorText, errorTone } from "@core/command-error";
import { clusterViews, coreCounts } from "@core/cpu-clusters";
import { formatPercent } from "@core/format";
import type { HostInfo } from "@core/generated/types";
import { CPU_HERO } from "@core/module-hero";
import { FULL_TABLE } from "@core/process-interest";
import { DAY_MS } from "@core/time-grid";
import { useMemo } from "react";
import { type ModuleRead, useModuleHistory } from "@/data/history";
import { useHosts } from "@/data/hosts-list";
import { remoteStatusLine } from "@/data/live";
import { HistoryNotice } from "@/module/history-notice";
import { LiveProcessTable } from "@/module/live-process-table";
import { ModuleChart } from "@/module/module-chart";
import { ModuleFrame } from "@/module/module-frame";
import { ModuleNotice } from "@/module/module-notice";
import type { ModulePageProps } from "@/module/pages/index";
import { useModulePage } from "@/module/use-module-page";
import { Card } from "@/ui/card";
import { CoreLoad } from "./core-load";
import { CpuStats } from "./stats";

const CPU_READ: ModuleRead = {
  module: "cpu",
  selection: CPU_HERO.keys.map((metric) => ({ metric, labels: [] })),
  gridKeys: CPU_HERO.keys,
};

function cpuSubtitle(info: HostInfo) {
  const { performance, efficiency, total } = coreCounts(info);
  const chip = info.chip ?? "Unknown chip";
  if (total === 0) return chip;
  return efficiency === 0
    ? `${chip} · ${total} cores`
    : `${chip} · ${performance} performance + ${efficiency} efficiency cores`;
}

/** Render the host's CPU history and current readings. */
export function CpuPage({ host, remote }: ModulePageProps) {
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
  } = useModulePage(host, remote);
  // The roster query also supplies the topology notice and its retry.
  const hosts = useHosts();
  const info = record?.info;
  const clusters = useMemo(
    () => clusterViews(info?.cpu_topology ?? []),
    [info?.cpu_topology]
  );
  const liveIssue =
    !live && connection.label !== "Connecting" ? connection.label : null;
  const history = useModuleHistory(host, CPU_READ, range, width, connected);
  const { data, displayedRange, grid, events } = history;
  const series = useMemo(
    () =>
      CPU_HERO.lines(grid?.values ?? {}).map((line) => ({
        ...line,
        label: line.key === "cpu.total" ? "Total" : "System",
      })),
    [grid]
  );
  const hasSamples = series.some(({ values }) =>
    values.some((value) => value !== null)
  );
  return (
    <ModuleFrame
      title="CPU"
      subtitle={info ? cpuSubtitle(info) : null}
      range={windowMs}
      onRange={setWindowMs}
      events={events}
      showDate={windowMs >= DAY_MS}
    >
      {connected ? (
        <>
          {liveIssue && <ModuleNotice message={liveIssue} />}
          <CpuStats host={host} remote={remote} stats={data?.stats} />
          <Card
            className="gap-2"
            testID="history-plot-layout"
            onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
          >
            <ModuleChart
              key={windowMs}
              series={series}
              gaps={data?.gaps ?? []}
              ceiling={100}
              format={formatPercent}
              range={displayedRange}
              nowMs={Math.max(displayedRange.toMs, range.toMs)}
              events={events ?? []}
              clockOffsetMs={range.offsetMs}
              height={160}
              accent="cpu"
              module="cpu"
              label="CPU history"
              grid={grid}
              loading={history.isPending}
            />
            <HistoryNotice
              query={history}
              hostName={record?.display_name}
              hasSamples={hasSamples}
            />
          </Card>
          {clusters.length > 0 ? (
            <CoreLoad
              host={host}
              hostName={record?.display_name}
              remote={remote}
              clusters={clusters}
              range={range}
            />
          ) : (
            hosts.isError && (
              <ModuleNotice
                message={`Couldn’t load CPU topology. ${commandErrorText(hosts.error, "Please try again.")}`}
                error={errorTone(hosts.error) === "error"}
                onRetry={() => void hosts.refetch()}
              />
            )
          )}
        </>
      ) : (
        <ModuleNotice
          message={remoteStatusLine(remote)?.label ?? "Reconnecting"}
        />
      )}
      <LiveProcessTable host={host} sort="cpu" view={FULL_TABLE} />
    </ModuleFrame>
  );
}
