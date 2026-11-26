import { commandErrorText, errorTone } from "@core/command-error";
import { clusterViews, coreCounts } from "@core/cpu-clusters";
import { formatPercent } from "@core/format";
import type { HostInfo } from "@core/generated/types";
import { CPU_HERO } from "@core/module-hero";
import { FULL_TABLE } from "@core/process-interest";
import { DAY_MS } from "@core/time-grid";
import { useMemo, useState } from "react";
import { useHistoryRange, useModuleHistory } from "@/data/history";
import { useHosts } from "@/data/hosts-list";
import { remoteStatusLine, useConnection } from "@/data/live";
import { HistoryNotice } from "@/module/history-notice";
import { LiveProcessTable } from "@/module/live-process-table";
import { ModuleChart } from "@/module/module-chart";
import { ModuleFrame } from "@/module/module-frame";
import { ModuleNotice } from "@/module/module-notice";
import type { ModulePageProps } from "@/module/pages/index";
import { Card } from "@/ui/card";
import { CoreLoad } from "./core-load";
import { CpuStats } from "./stats";

function cpuSubtitle(info: HostInfo) {
  const { performance, efficiency, total } = coreCounts(info);
  const chip = info.chip ?? "Unknown chip";
  if (total === 0) return chip;
  return efficiency === 0
    ? `${chip} · ${total} cores`
    : `${chip} · ${performance} performance + ${efficiency} efficiency cores`;
}

export function CpuPage({
  host,
  range: defaultRange,
  remote,
}: ModulePageProps) {
  const [windowMs, setWindowMs] = useState(defaultRange);
  const [width, setWidth] = useState<number | null>(null);
  const hosts = useHosts();
  const record = hosts.data?.find(({ id }) => id === host);
  const info = record?.info;
  const clusters = useMemo(
    () => clusterViews(info?.cpu_topology ?? []),
    [info?.cpu_topology]
  );
  const connected = remote === undefined || remote.state === "connected";
  const clockOffset = remote?.clock_offset_ms ?? 0;
  const range = useHistoryRange(windowMs, clockOffset);
  const connection = useConnection(host, remote, null);
  const liveIssue =
    connection.state !== "live" && connection.label !== "Connecting"
      ? connection.label
      : null;
  const history = useModuleHistory(host, "cpu", range, width, connected);
  const { data, displayedRange, grid } = history;
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
              clockOffsetMs={clockOffset}
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
