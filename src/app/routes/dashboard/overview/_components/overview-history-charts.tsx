import type { TimeRange } from "@core/brush";
import { formatRate } from "@core/format";
import type { DiskIoPage } from "@core/generated/bindings";
import { useMemo } from "react";
import { ChartHistoryStatus } from "~/components/chart-history-status";
import { COMPACT_PLOT_INSET } from "~/components/charts/layout";
import { MirrorChart } from "~/components/charts/mirror-chart";
import { ModuleHistoryChart } from "~/components/charts/module-history-chart";
import { useDiskIoReadWriteChart } from "~/components/disk-io-chart";
import { InlineMessage } from "~/components/inline-message";
import { LiveMirrorChart } from "~/components/live-mirror-chart";
import { type HeroChartSpec, NETWORK_HERO } from "~/components/module-hero";
import type { useDiskIo } from "~/hooks/use-disk-io";
import { useGapBands } from "~/hooks/use-gap-bands";
import { useModuleChart } from "~/hooks/use-module-chart";
import { useUnits } from "~/hooks/use-units";
import type { GapSpan } from "~/widgets/gap-band";
import type { Accent } from "~/widgets/lib/accent";
import {
  DEFAULT_LINE_WEIGHT,
  type StreamAreaProps,
} from "~/widgets/stream-area";

import { MIRROR_BARS } from "../_lib/chart-layout";

const AREA_HEIGHT = 88;
const MIRROR_HEIGHT = 44;

/**
 * A caption would cover a third of a 300 px card; the hatched band stays
 * and keeps its accessible name, and the module page shows the caption.
 */
/**
 * Overview charts are a third the width of a module page's, so a module
 * page's line weight hides the detail; draw them at half weight.
 */
function thinned(lines: StreamAreaProps["series"]): StreamAreaProps["series"] {
  return lines.map((l) => ({
    ...l,
    weight: (l.weight ?? DEFAULT_LINE_WEIGHT) / 2,
  }));
}

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
      lines={thinned(spec.lines(chart.series.values))}
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
      {...NETWORK_HERO.chart}
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
      {!devicesFailed && query.data && range && (
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
