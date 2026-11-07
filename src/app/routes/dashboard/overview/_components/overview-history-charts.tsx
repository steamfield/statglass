import type { TimeRange } from "@core/brush";
import { formatRate } from "@core/format";
import type { DiskIoPage } from "@core/generated/bindings";
import { keyByLabel } from "@core/series-key";
import { useMemo } from "react";
import { ChartHistoryStatus } from "~/components/chart-history-status";
import { COMPACT_PLOT_INSET } from "~/components/charts/layout";
import { MirrorChart } from "~/components/charts/mirror-chart";
import {
  type HeroChartSpec,
  NETWORK_HERO,
} from "~/components/charts/module-hero";
import { ModuleHistoryChart } from "~/components/charts/module-history-chart";
import { InlineMessage } from "~/components/inline-message";
import { LiveMirrorChart } from "~/components/live-mirror-chart";
import { useGapBands } from "~/hooks/use-gap-bands";
import { useHostRecord } from "~/hooks/use-host-record";
import { useIsLocalHost } from "~/hooks/use-is-local-host";
import { useModuleChart } from "~/hooks/use-module-chart";
import { useModuleEnd } from "~/hooks/use-module-end";
import { useOpenEdge } from "~/hooks/use-range-scope";
import { useHeld } from "~/hooks/use-ring";
import { useUnits } from "~/hooks/use-units";
import { useDiskIoReadWriteChart } from "~/routes/dashboard/disk/_components/disk-io-charts";
import {
  useDiskDevices,
  useDiskIo,
} from "~/routes/dashboard/disk/_hooks/use-disk-io";
import { useHost } from "~/stores/host-store";
import type { GapSpan } from "~/widgets/gap-band";
import type { Accent } from "~/widgets/lib/accent";

const AREA_HEIGHT = 88;
const MIRROR_HEIGHT = 44;
/** Bars in a ~220 px mirror plot, the same count the Disk card queries. */
const MIRROR_BARS = 40;

/**
 * A caption would cover a third of a 300 px card; the hatched band stays
 * and keeps its accessible name, and the module page shows the caption.
 */
function uncaptioned<T extends GapSpan>(gaps: readonly T[]): T[] {
  return gaps.map((g) => ({ ...g, showCaption: false }));
}

export function OverviewHistoryChart({
  spec,
  windowMs,
  accent,
}: {
  spec: HeroChartSpec;
  windowMs: number;
  accent: Accent;
}) {
  const chart = useModuleChart(spec.keys, windowMs, spec.module, { ticks: 3 });
  const gaps = useMemo(() => uncaptioned(chart.gaps), [chart.gaps]);
  return (
    <ModuleHistoryChart
      chart={{ ...chart, gaps }}
      lines={spec.lines(chart.series.values)}
      yAxis={spec.yAxis}
      accent={accent}
      height={AREA_HEIGHT}
      subject={spec.subject}
    />
  );
}

export function OverviewNetworkChart({ windowMs }: { windowMs: number }) {
  const rate = useUnits().rate;
  const bands = useGapBands("network");
  const gaps = useMemo(() => uncaptioned(bands), [bands]);
  return (
    <LiveMirrorChart
      {...NETWORK_HERO}
      windowMs={windowMs}
      accent="net"
      format={(v) => formatRate(v, { units: rate })}
      gaps={gaps}
      hover={false}
      ticks={3}
      inset={COMPACT_PLOT_INSET}
      maxBars={MIRROR_BARS}
      upHeight={MIRROR_HEIGHT}
      downHeight={MIRROR_HEIGHT}
    />
  );
}

/** Match the Disk page's initial device and open edge, without a brush or URL selection. */
export function useOverviewDisk(windowMs: number) {
  const local = useIsLocalHost();
  const host = useHostRecord();
  const inventory = useDiskDevices(local && host !== undefined);
  const devices = useHost((s) => s.capabilities?.disk_devices);
  const device = local
    ? (inventory.data?.default_device ?? null)
    : (devices?.find((d) => d.default)?.dev ?? devices?.[0]?.dev ?? null);
  const fixedEnd = useModuleEnd();
  const edge = useOpenEdge(fixedEnd === null);
  const end = fixedEnd ?? edge;
  const range =
    end !== null && (!local || inventory.data !== undefined)
      ? { fromMs: end - windowMs, toMs: end }
      : null;
  const query = useDiskIo(device, range, MIRROR_BARS, fixedEnd === null);
  const readKey =
    device === null
      ? "disk.read_total"
      : keyByLabel("disk.read", "dev")(device);
  const writeKey =
    device === null
      ? "disk.write_total"
      : keyByLabel("disk.write", "dev")(device);
  const values = useHeld([readKey, writeKey]);
  return {
    devicesFailed: local && inventory.isError,
    read: values[readKey] ?? null,
    write: values[writeKey] ?? null,
    query,
    range,
    fixedEnd,
  };
}

export function OverviewDiskChart({
  devicesFailed,
  query,
  range,
  fixedEnd,
}: {
  devicesFailed: boolean;
  query: ReturnType<typeof useDiskIo>;
  range: TimeRange | null;
  fixedEnd: number | null;
}) {
  return (
    <div className="flex min-h-28 flex-col gap-1.5">
      {devicesFailed ? (
        <InlineMessage tone="status">Couldn't load disk devices.</InlineMessage>
      ) : (
        <ChartHistoryStatus loading={query.isPending} error={query.isError} />
      )}
      {query.data && range && (
        <DiskPlot page={query.data} range={range} fixedEnd={fixedEnd} />
      )}
    </div>
  );
}

function DiskPlot({
  page,
  range,
  fixedEnd,
}: {
  page: DiskIoPage;
  range: TimeRange;
  fixedEnd: number | null;
}) {
  const { chart } = useDiskIoReadWriteChart(page, range, fixedEnd);
  const gaps = useMemo(() => uncaptioned(chart.gaps ?? []), [chart.gaps]);
  const rate = useUnits().rate;
  return (
    <MirrorChart
      {...chart}
      gaps={gaps}
      format={(v) => formatRate(v, { units: rate })}
      hover={false}
      ticks={3}
      inset={COMPACT_PLOT_INSET}
      upHeight={MIRROR_HEIGHT}
      downHeight={MIRROR_HEIGHT}
    />
  );
}
