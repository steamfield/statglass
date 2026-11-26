import { fixed, formatPercent, MISSING } from "@core/format";
import type { SeriesHistoryStats } from "@core/generated/types";
import { held } from "@core/live-selectors";
import { spanWords } from "@core/live-window";
import { IDLE_STATE, type ResidencyRow, residencyRows } from "@core/residency";
import { labelOf } from "@core/series-key";
import {
  RING_GAUGE_DIMENSIONS,
  ringGaugeModel,
} from "@core/widget-models/ring-gauge";
import type { StackBarSegment } from "@core/widget-models/stack-bar";
import { useMemo } from "react";
import { useWindowDimensions, View } from "react-native";
import { useConnection, useHostLive } from "@/data/live";
import type { ModulePageProps } from "@/module/pages/index";
import { Card } from "@/ui/card";
import { Text } from "@/ui/text";
import { RingGauge } from "@/widgets/ring-gauge";
import { StackBar } from "@/widgets/stack-bar";

const size = 112;
const ramp = [1, 2, 3, 4] as const;
const ghz = (value: number) => fixed(value / 1e9, 2);

function residencyStats(stats: readonly SeriesHistoryStats[]) {
  const averages: Record<string, number | null> = {};
  for (const { key, avg } of stats) {
    if (key.metric !== "gpu.residency") continue;
    const state = labelOf(key, "state");
    if (state !== undefined) averages[state] = avg;
  }
  return residencyRows(averages);
}

function Residency({
  rows,
  span,
}: {
  rows: readonly ResidencyRow[];
  span: string;
}) {
  const idle = rows.find(({ label }) => label === IDLE_STATE)?.pct;
  const segments = rows.map(
    ({ label, pct }, i): StackBarSegment => ({
      key: label,
      label,
      value: formatPercent(pct),
      fraction: pct / 100,
      step: label === IDLE_STATE ? "track" : (ramp[i] ?? 4),
    })
  );
  return (
    <View className="min-w-0 flex-1 gap-2">
      <View className="flex-row flex-wrap justify-between gap-x-2">
        <Text variant="caption">{span}</Text>
        {idle !== undefined && (
          <Text variant="caption">active {formatPercent(100 - idle)}</Text>
        )}
      </View>
      <StackBar
        segments={segments}
        accent="gpu"
        showLegend
        legendColumns={1}
        ariaLabel={`${span} residency: ${segments.map(({ label, value }) => `${label} ${value}`).join(", ")}`}
      />
    </View>
  );
}

export function Frequency({
  host,
  remote,
  dvfsMhz,
  stats,
  windowMs,
}: Pick<ModulePageProps, "host" | "remote"> & {
  dvfsMhz: number[] | undefined;
  stats: readonly SeriesHistoryStats[] | undefined;
  windowMs: number;
}) {
  const freq = useHostLive(host, (state) => held(state, "gpu.freq"));
  const live = useConnection(host, remote, null).state === "live";
  const { fontScale } = useWindowDimensions();
  const max = Math.max(0, ...(dvfsMhz ?? [])) * 1e6;
  const model = ringGaugeModel(
    {
      value: live ? freq : null,
      max,
      format: ghz,
      label: "GHz",
      secondary: `max ${max > 0 ? ghz(max) : MISSING}`,
      accent: "gpu",
    },
    RING_GAUGE_DIMENSIONS[size]
  );
  const rows = useMemo(() => (stats ? residencyStats(stats) : null), [stats]);
  const span = spanWords(windowMs, null);
  return (
    <Card className="gap-2">
      <Text variant="cardTitle" accessibilityRole="header">
        Frequency
      </Text>
      <View
        className={fontScale > 1.5 ? "gap-3" : "flex-row items-start gap-3"}
      >
        <RingGauge model={model} size={size} />
        {rows && rows.length > 0 ? (
          <Residency rows={rows} span={span} />
        ) : (
          stats && (
            <View className="min-w-0 flex-1">
              <Text variant="caption">
                No frequency residency samples in the {span}
              </Text>
            </View>
          )
        )}
      </View>
    </Card>
  );
}
