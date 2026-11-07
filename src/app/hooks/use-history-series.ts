import { HISTORY_TIERS, RING_SPAN_MS } from "@core/generated/bindings";
import { historyGrid } from "@core/history-grid";
import { historyKeys, sameModuleSeries } from "@core/query-keys";
import { seriesKeyString } from "@core/series-key";
import { floorTo, MINUTE_MS } from "@core/time-grid";
import { unwrap } from "@core/transport";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useModuleEnd } from "~/hooks/use-module-end";
import { useOpenEdge } from "~/hooks/use-range-scope";
import { useHostClock } from "~/lib/host-clock";
import { holdWhile } from "~/lib/queries/hold";
import { useTransport } from "~/lib/transport-context";
import { useHost, useHostId } from "~/stores/host-store";
import { currentLayout } from "~/stores/live-selectors";

/** Bounded retained-history reads. Relative ranges refresh once per displayed bucket. */
export function useHistorySeries(
  keys: readonly string[],
  windowMs: number,
  points: number,
  breakAtGaps = true
) {
  const end = useModuleEnd();
  const enabled = windowMs > RING_SPAN_MS || end !== null;
  const clock = useHostClock();
  const hostId = useHostId();
  const transport = useTransport();
  const width = Math.max(
    HISTORY_TIERS[0].bucket_ms,
    Math.min(MINUTE_MS, Math.ceil(windowMs / points))
  );
  const edge = useOpenEdge(enabled && end === null, width);
  // A disabled history observer must not rotate cache entries as the live clock moves.
  const toMs = enabled ? (end ?? edge ?? floorTo(clock(), width)) : 0;
  const keyList = keys.join("\n");
  const stableKeys = useMemo(
    () => (keyList ? keyList.split("\n") : []),
    [keyList]
  );
  const layout = useHost(currentLayout);
  const queryKey = historyKeys.moduleSeries(
    hostId,
    stableKeys,
    windowMs,
    toMs,
    points,
    end !== null
  );
  const query = useQuery({
    queryKey,
    queryFn: () => {
      const selectors = stableKeys.map((key) => {
        const known = layout?.series.find(
          (series) => seriesKeyString(series) === key
        );
        // Unlabelled historic series may be absent from the current layout.
        return known ?? { metric: key, labels: [] };
      });
      return unwrap(
        transport.queryHistory({
          host: hostId,
          selectors,
          from_ms: toMs - windowMs,
          to_ms: toMs,
          tier: "auto",
          max_points: points,
        })
      );
    },
    enabled: enabled && stableKeys.length > 0,
    placeholderData: holdWhile(queryKey, sameModuleSeries),
  });
  const grid = useMemo(
    () =>
      query.data
        ? historyGrid(
            query.data,
            stableKeys,
            toMs - windowMs,
            toMs,
            breakAtGaps
          )
        : null,
    [query.data, stableKeys, windowMs, toMs, breakAtGaps]
  );
  return {
    enabled,
    grid,
    page: query.data,
    loading: enabled && stableKeys.length > 0 && query.isPending,
    error: enabled && query.isError,
  };
}
