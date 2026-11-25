import { fixed, formatPercent, MISSING } from "@core/format";
import type { SeriesHistoryStats } from "@core/generated/types";
import { currentLayout, held, selectCpu } from "@core/live-selectors";
import type { HostLive } from "@core/live-state";
import { sk } from "@core/series-key";
import { shallow } from "zustand/shallow";
import {
  useConnection,
  useHostLive,
  useHostLiveSubscription,
} from "@/data/live";
import type { ModulePageProps } from "@/module/pages/index";
import { type StatItem, StatStrip } from "@/module/stat-strip";

const loadAvg1 = sk("cpu.loadavg", { window: "1" });
const loadAvg5 = sk("cpu.loadavg", { window: "5" });
const loadAvg15 = sk("cpu.loadavg", { window: "15" });
const psiSome = sk("cpu.psi", { stall: "some" });
const psiFull = sk("cpu.psi", { stall: "full" });
const noStats: readonly SeriesHistoryStats[] = [];
const percent1 = (value: number | null) =>
  formatPercent(value, { decimals: 1 });
const load = (value: number | null) =>
  value === null ? MISSING : fixed(value, 2);

function selectStrip(state: HostLive) {
  const { total, user, system, iowait } = selectCpu(state);
  return {
    total,
    user,
    system,
    iowait,
    steal: held(state, "cpu.steal"),
    load1: held(state, loadAvg1),
    load5: held(state, loadAvg5),
    load15: held(state, loadAvg15),
    some: held(state, psiSome),
    full: held(state, psiFull),
  };
}

export function CpuStats({
  host,
  remote,
  stats = noStats,
}: Pick<ModulePageProps, "host" | "remote"> & {
  stats: readonly SeriesHistoryStats[] | undefined;
}) {
  useHostLiveSubscription(host);
  const values = useHostLive(host, selectStrip, shallow);
  const layout = useHostLive(host, currentLayout);
  const live = useConnection(host, remote, null).state === "live";
  const has = (metric: string) => layout?.byMetric.has(metric) ?? false;
  const hasWait = has("cpu.iowait");
  const reading = (value: number | null) => (live ? value : null);
  const total = reading(values.total);
  const iowait = reading(values.iowait);
  // Match src/app/routes/dashboard/cpu/_components/total-card.tsx.
  const idle =
    total === null || (hasWait && iowait === null)
      ? null
      : 100 - total - (iowait ?? 0);
  const items: StatItem[] = [
    { label: "User", value: percent1(reading(values.user)) },
    { label: "System", value: percent1(reading(values.system)) },
  ];
  if (hasWait) items.push({ label: "I/O wait", value: percent1(iowait) });
  if (has("cpu.steal"))
    items.push({ label: "Steal", value: percent1(reading(values.steal)) });
  items.push(
    { label: "Idle", value: percent1(idle) },
    {
      label: "Load avg",
      value: [values.load1, values.load5, values.load15]
        .map((v) => load(reading(v)))
        .join(" · "),
    }
  );
  if (has("cpu.psi"))
    items.push({
      label: "Pressure stall",
      value: `${percent1(reading(values.some))} · full ${percent1(reading(values.full))}`,
    });
  return (
    <StatStrip
      lead={{
        label: "Total",
        value: formatPercent(total),
        seriesKey: "cpu.total",
        format: formatPercent,
        formatAvg: percent1,
      }}
      items={items}
      stats={stats}
    />
  );
}
