import type { ClusterView } from "@core/cpu-clusters";
import {
  formatDuration,
  formatHistoryTime,
  formatPercent,
  resolutionWords,
} from "@core/format";
import { historyGrid } from "@core/history-grid";
import { gapBands } from "@core/history-state";
import { selectCpuCores } from "@core/live-selectors";
import { spanWords } from "@core/live-window";
import { seriesKey, seriesKeyString } from "@core/series-key";
import { DAY_MS } from "@core/time-grid";
import { gapBandsModel } from "@core/widget-models/gap-band";
import { heatMatrixModel } from "@core/widget-models/heat-matrix";
import { useMemo, useState } from "react";
import { useWindowDimensions, View } from "react-native";
import { shallow } from "zustand/shallow";
import {
  type HistoryRange,
  useHostHistory,
  useRefreshOnRangeChange,
} from "@/data/history";
import { useConnection, useHostLive } from "@/data/live";
import { HistoryNotice } from "@/module/history-notice";
import type { ModulePageProps } from "@/module/pages/index";
import { Card } from "@/ui/card";
import { Text } from "@/ui/text";
import {
  type HeatColumns,
  HeatMatrix,
  scaled,
  squareCellColumns,
} from "@/widgets/heat-matrix";

/** Room for "P11" and "100%" at the default text size. */
const SIDES: HeatColumns = { label: 28, reading: 34 };
// The card's p-3 on each side.
const CARD_PADDING = 24;

function HeatmapTimeScale({
  windowMs,
  endMs,
  nowMs,
}: {
  windowMs: number;
  endMs: number;
  nowMs: number;
}) {
  const side = scaled(SIDES, useWindowDimensions().fontScale);
  return (
    <View className="flex-row items-center gap-2">
      <View style={{ width: side.label }} />
      <View className="flex-1 flex-row justify-between gap-1">
        <Text variant="axis">−{formatDuration(windowMs)}</Text>
        <Text variant="axis">−{formatDuration(windowMs / 2)}</Text>
        <Text variant="axis" className="shrink text-right">
          {endMs >= nowMs
            ? "now"
            : formatHistoryTime(endMs, windowMs >= DAY_MS)}
        </Text>
      </View>
      <View style={{ width: side.reading }} />
    </View>
  );
}

function coreGrouping(cores: readonly { letter: ClusterView["letter"] }[]) {
  const efficiency = cores.filter(({ letter }) => letter === "E").length;
  return efficiency === 0
    ? `${cores.length} cores in one group`
    : `${cores.length - efficiency} performance cores, ${efficiency} efficiency cores`;
}

export function CoreLoad({
  host,
  hostName,
  remote,
  clusters,
  range,
}: Pick<ModulePageProps, "host" | "remote"> & {
  hostName: string | undefined;
  clusters: readonly ClusterView[];
  range: HistoryRange;
}) {
  const [width, setWidth] = useState(0);
  const laidOut = width > 0;
  const { fontScale } = useWindowDimensions();
  const count = laidOut
    ? squareCellColumns(width - CARD_PADDING, SIDES, fontScale)
    : 0;
  const columns = useMemo(() => ({ columns: count }), [count]);
  const cores = useMemo(
    () =>
      clusters.flatMap(({ letter, cores }) =>
        cores.map((id) => {
          const selector = seriesKey("cpu.load", { core: id });
          return { id, letter, selector, key: seriesKeyString(selector) };
        })
      ),
    [clusters]
  );
  const selection = useMemo(
    () => cores.map(({ selector }) => selector),
    [cores]
  );
  const history = useHostHistory(
    host,
    selection,
    range,
    laidOut && selection.length > 0 ? columns : null
  );
  const windowMs = range.toMs - range.fromMs;
  useRefreshOnRangeChange(windowMs, history);
  const { data } = history;
  const grid = useMemo(
    () =>
      data
        ? historyGrid(
            data.page,
            cores.map(({ key }) => key),
            data.range.fromMs,
            data.range.toMs,
            false
          )
        : null,
    [cores, data]
  );
  const current = useHostLive(host, selectCpuCores, shallow);
  const live = useConnection(host, remote, null).state === "live";
  const span = spanWords(windowMs, null);
  const title = `Per-core load, ${span}`;
  const covered = useMemo(
    () =>
      Object.values(grid?.values ?? {}).filter((values) =>
        values.some((value) => value !== null)
      ).length,
    [grid]
  );
  const model = heatMatrixModel({
    rows: cores.map(({ id, key, letter }) => ({
      key,
      label: id,
      group: letter,
      current: live ? (current[id] ?? null) : null,
      values: grid?.values[key] ?? [],
    })),
    timeline: {
      windowMs,
      bucketMs: grid?.bucketMs ?? windowMs / Math.max(count, 1),
      endMs: grid?.endMs ?? null,
    },
    domain: [0, 100],
    format: formatPercent,
    accent: "cpu",
    ariaLabel: grid
      ? `${title}, ${coreGrouping(cores)}, ${covered} of ${cores.length} cores with history, each column a ${resolutionWords(grid.bucketMs)}`
      : title,
  });
  const bands = useMemo(() => {
    if (!data || !grid) return [];
    const toMs = grid.endMs + grid.bucketMs;
    const fromMs = toMs - model.columns * grid.bucketMs;
    return gapBandsModel(
      gapBands(data.page.gaps, data.range.fromMs, data.range.toMs, {
        module: "cpu",
        style: "duration",
      }),
      fromMs,
      toMs
    ).map((band) => ({ ...band, showCaption: false }));
  }, [data, grid, model.columns]);
  return (
    <Card
      className="gap-2"
      testID="core-heatmap-layout"
      onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
    >
      <Text variant="cardTitle" accessibilityRole="header">
        {title}
      </Text>
      {laidOut && (
        <>
          {grid && data && (
            <>
              <HeatMatrix
                model={model}
                height={0}
                gapBands={bands}
                sides={SIDES}
              />
              <HeatmapTimeScale
                windowMs={windowMs}
                endMs={data.range.toMs}
                nowMs={range.toMs}
              />
            </>
          )}
          <HistoryNotice
            query={history}
            hostName={hostName}
            hasSamples={covered > 0}
          />
        </>
      )}
    </Card>
  );
}
