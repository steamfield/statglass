import { formatGhz, formatPercent, formatWatts } from "@core/format";
import type { SeriesHistoryStats } from "@core/generated/types";
import { selectGpu } from "@core/live-selectors";
import { shallow } from "zustand/shallow";
import { useConnection, useHostLive } from "@/data/live";
import type { ModulePageProps } from "@/module/pages/index";
import { StatStrip } from "@/module/stat-strip";

export function GpuStats({
  host,
  remote,
  stats,
}: Pick<ModulePageProps, "host" | "remote"> & {
  stats: readonly SeriesHistoryStats[] | undefined;
}) {
  const { util, render, tiler, freqHz, powerW } = useHostLive(
    host,
    selectGpu,
    shallow
  );
  const live = useConnection(host, remote, null).state === "live";
  const reading = (value: number | null) => (live ? value : null);
  return (
    <StatStrip
      lead={{
        label: "Utilization",
        value: formatPercent(reading(util)),
        seriesKey: "gpu.util",
        format: formatPercent,
        formatAvg: (value) => formatPercent(value, { decimals: 1 }),
      }}
      items={[
        { label: "Renderer", value: formatPercent(reading(render)) },
        { label: "Tiler", value: formatPercent(reading(tiler)) },
        {
          label: "Frequency",
          value: formatGhz(reading(freqHz), { decimals: 2 }),
        },
        { label: "Power", value: formatWatts(reading(powerW)) },
      ]}
      stats={stats ?? []}
    />
  );
}
