import {
  type ByteUnits,
  formatBytes,
  formatEnergy,
  formatPercent,
  formatSpan,
} from "@core/format";
import {
  type HistoricalUsageReply,
  USAGE_HISTORY_MAX_RANGE_MS,
  type UsageByApp,
  type UsageKey,
} from "@core/generated/bindings";
import {
  HISTORICAL_LABELS,
  historicalCoverage,
  historicalFigure,
  historicalValue,
} from "@core/historical-usage";
import {
  gpuShortfall,
  usageCoverage,
  usageRows,
  usageValue,
} from "@core/usage-rows";
import { useState } from "react";
import { useHistoricalUsage } from "~/hooks/use-historical-usage";
import { useUsageHistorical } from "~/hooks/use-module-end";
import { useRangeScope } from "~/hooks/use-range-scope";
import { useUnits } from "~/hooks/use-units";
import { useUsageByApp } from "~/hooks/use-usage-by-app";
import { useHostId } from "~/stores/host-store";

export type TopAppsMetric = Extract<
  UsageKey,
  "cpu" | "memory" | "gpu" | "energy"
>;

/** Compact ranking over the same range and attribution paths as the module tables. */
export function useTopApps(windowMs: number, by: TopAppsMetric) {
  const historical = useUsageHistorical(windowMs);
  const { range, keepPrevious } = useRangeScope(windowMs);
  const live = useUsageByApp(historical ? null : range, by);
  const history = useHistoricalUsage(historical ? range : null, by);
  const host = useHostId();
  const units = useUnits();
  // The card owns the holds for both paths. Keep only the same host,
  // metric and window's last answer while its open edge advances.
  const key = `${host}:${by}:${windowMs}:${historical}:${keepPrevious}`;
  const recorded = useRollingAnswer(history.data, key, keepPrevious);
  const recent = useRollingAnswer(live.data, key, keepPrevious);
  const beyondHistory = historical && windowMs > USAGE_HISTORY_MAX_RANGE_MS;
  const isError = historical ? history.isError : live.isError;
  return {
    ...(historical
      ? recordedApps(recorded, by, units.bytes)
      : recentApps(recent, by, units.bytes)),
    historical,
    caption: !historical && by === "energy" ? "Energy" : HISTORICAL_LABELS[by],
    beyondHistory,
    isPending: !beyondHistory && !isError && !(historical ? recorded : recent),
    isError,
  };
}

/**
 * Hold only the same host, metric and window while a rolling edge advances.
 * holdWhile is a query-level placeholder callback; useHistoricalUsage exposes
 * no placeholder option. useUsageByApp's useRangeQuery keepPrevious checks the
 * host and span by default, but its wrapper exposes no metric identity predicate.
 * Holding here gives both paths the same host/metric/window guard without
 * changing the shared hooks' callers.
 */
function useRollingAnswer<T>(
  data: T | undefined,
  key: string,
  keepPrevious: boolean
) {
  const [held, setHeld] = useState({ key, data });
  if (held.key !== key || (data !== undefined && data !== held.data))
    setHeld({ key, data });
  return data ?? (keepPrevious && held.key === key ? held.data : undefined);
}

function recordedApps(
  recorded: HistoricalUsageReply | undefined,
  by: TopAppsMetric,
  units: ByteUnits
) {
  const rows =
    recorded?.apps.slice(0, 5).map((app) => ({
      id: app.name,
      name: app.name,
      value: historicalFigure(historicalValue(app.figures, by), by, units),
    })) ?? [];
  const coverage = recorded?.range.coverage.find(
    (c) => c.metric === by
  )?.coverage;
  const incomplete =
    recorded && (!recorded.ranking_complete || !coverage?.complete);
  const note = incomplete
    ? `${HISTORICAL_LABELS[by]}: ${historicalCoverage(coverage, recorded.range.requested_to_ms - recorded.range.requested_from_ms)}.${!recorded.ranking_complete ? " Observed ranking; some use could not be recorded." : ""}`
    : null;
  return { rows, note };
}

function recentApps(
  recent: UsageByApp | undefined,
  by: TopAppsMetric,
  units: ByteUnits
) {
  const rows = recent
    ? usageRows(recent, by, "")
        .slice(0, 5)
        .map(({ app }) => ({
          id: app.name,
          name: app.name,
          value: liveFigure(usageValue(by, app), by, units),
        }))
    : [];
  return { rows, note: recent ? liveCoverage(recent, by) : null };
}

function liveFigure(value: number | null, by: TopAppsMetric, units: ByteUnits) {
  if (by === "energy") return formatEnergy(value);
  if (by === "memory") return formatBytes(value, { units });
  return formatPercent(value, { decimals: 1 });
}

function liveCoverage(data: UsageByApp, by: TopAppsMetric): string | null {
  const coverage = usageCoverage(data);
  if (coverage.kind === "waiting") return "Waiting for app samples";
  if (coverage.kind === "unrecorded")
    return "App activity was not recorded for this interval";
  if (coverage.kind === "partial" || coverage.kind === "gaps")
    return `${formatSpan(coverage.coveredMs)} of ${formatSpan(data.to_ms - data.from_ms)} recorded`;
  const gpu = by === "gpu" ? gpuShortfall(data) : null;
  return gpu
    ? `GPU: ${formatSpan(gpu.gpuMs)} of ${formatSpan(gpu.coveredMs)} recorded`
    : null;
}
