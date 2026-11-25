import { ratio } from "@core/chart-math";
import { fixed, formatBytes, formatPercent, MISSING } from "@core/format";
import { METRIC_CODES, type SeriesHistoryStats } from "@core/generated/types";
import { held, keysOf, selectMemory } from "@core/live-selectors";
import type { HostLive } from "@core/live-state";
import { seriesKeyString } from "@core/series-key";
import type { StackBarSegment } from "@core/widget-models/stack-bar";
import { View } from "react-native";
import { shallow } from "zustand/shallow";
import { StatusIcon } from "@/cards/module-card";
import { useHostLive } from "@/data/live";
import type { ModulePageProps } from "@/module/pages/index";
import { type StatItem, StatStrip } from "@/module/stat-strip";
import { Text } from "@/ui/text";
import { StackBar } from "@/widgets/stack-bar";
import { StatList } from "@/widgets/stat-list";

type LiveProps = Pick<ModulePageProps, "host"> & { live: boolean };

const PRESSURE = METRIC_CODES["mem.pressure_level"];
const pressureState = (value: number | null) => {
  switch (value) {
    case PRESSURE.normal:
      return "normal";
    case PRESSURE.warn:
      return "warn";
    case PRESSURE.critical:
      return "critical";
    default:
      return null;
  }
};

function selectComposition(state: HostLive) {
  return {
    ...selectMemory(state),
    hasCompressed: keysOf(state, "mem.compressed").length > 0,
    hasPsi: keysOf(state, "mem.psi").length > 0,
    psiFull: held(state, "mem.psi{stall=full}"),
  };
}

export function MemoryComposition({
  host,
  live,
  total,
  stats,
}: LiveProps & { total: number | null; stats: readonly SeriesHistoryStats[] }) {
  const mem = useHostLive(host, selectComposition, shallow);
  const current = (value: number | null) => (live ? value : null);
  const bytes = (value: number | null) => formatBytes(current(value));
  const segment = (
    key: string,
    label: string,
    value: number | null,
    step: StackBarSegment["step"]
  ): StackBarSegment => ({
    key,
    label,
    value: bytes(value),
    fraction: ratio(current(value), total),
    step,
  });
  const segments = mem.composition
    ? [
        segment("app", "App", mem.app, 1),
        segment("wired", "Wired", mem.wired, 2),
      ]
    : [segment("used", "Used", mem.used, 1)];
  if (mem.hasCompressed)
    segments.push(segment("compressed", "Compressed", mem.compressed, "hatch"));
  segments.push(
    segment("cached", "Cached files", mem.cached, 4),
    segment("free", "Free", mem.free, "track")
  );

  const state = pressureState(current(mem.pressureLevel));
  const severity =
    state === "warn" ? "warning" : state === "critical" ? "critical" : null;
  const items: StatItem[] = [];
  if (mem.hasPsi && !mem.hasPressure) {
    const some = formatPercent(current(mem.psiSome), { decimals: 1 });
    const full = formatPercent(current(mem.psiFull), { decimals: 1 });
    items.push({ label: "Pressure stall", value: `${some} · full ${full}` });
  } else {
    const reading = formatPercent(current(mem.pressure));
    items.push({
      label: "Pressure",
      value: state === "normal" ? `${reading} ${state}` : reading,
    });
  }
  items.push({ label: "Swap", value: bytes(mem.swapUsed) });
  if (mem.hasCompressed)
    items.push({ label: "Compressed", value: bytes(mem.compressed) });
  const peak = (metric: string) =>
    formatBytes(stats.find(({ key }) => seriesKeyString(key) === metric)?.peak);
  items.push(
    { label: "Peak used", value: peak("mem.used") },
    { label: "Peak swap", value: peak("mem.swap_used") }
  );
  return (
    <View className="gap-3">
      <StatStrip
        lead={{ label: "Used", value: bytes(mem.used) }}
        items={items}
        stats={stats}
      />
      {severity && (
        <View className="flex-row items-center gap-1.5">
          <StatusIcon kind={severity} />
          <Text variant="label" accessibilityRole="alert">
            Pressure: {state}
          </Text>
        </View>
      )}
      <StackBar accent="mem" showLegend segments={segments} />
    </View>
  );
}

function selectSwap(state: HostLive) {
  return {
    used: held(state, "mem.swap_used"),
    inRate: held(state, "mem.swap_in"),
    outRate: held(state, "mem.swap_out"),
  };
}

export function SwapStats({ host, live }: LiveProps) {
  const { used, inRate, outRate } = useHostLive(host, selectSwap, shallow);
  const pages = (value: number | null) =>
    live && value !== null ? fixed(value, 0) : MISSING;
  return (
    <StatList
      layout="strip"
      items={[
        { label: "Used", value: formatBytes(live ? used : null) },
        { label: "In", value: pages(inRate), unit: "pages/s" },
        { label: "Out", value: pages(outRate), unit: "pages/s" },
      ]}
    />
  );
}
