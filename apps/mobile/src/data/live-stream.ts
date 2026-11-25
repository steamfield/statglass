import { type CeilingState, nextCeiling } from "@core/chart-math";
import type { HostId } from "@core/generated/types";
import { gridIntervalMs, ringLoading, seriesWindow } from "@core/live-state";
import { scaledWindowMs, spanWords, windowLabel } from "@core/live-window";
import { MINUTE_MS } from "@core/time-grid";
import type { MirrorBarsData } from "@core/widget-models/mirror-bars";
import type { StreamAreaData } from "@core/widget-models/stream-area";
import type { Accent } from "@core/widget-models/tokens";
import { useMemo, useRef } from "react";
import { shallow } from "zustand/shallow";
import { useHostLive } from "./live";

function useLiveWindow(host: HostId, baseMs: number) {
  const state = useHostLive(
    host,
    (s) => ({
      columns: s.columns,
      layouts: s.layouts,
      lastTsMs: s.lastTsMs,
      status: s.status,
      rowsVersion: s.rowsVersion,
      connection: s.connection,
      historyPending: s.historyPending,
    }),
    shallow
  );
  const windowMs = scaledWindowMs(baseMs, gridIntervalMs(state.status));
  return { state, windowMs, loading: ringLoading(state, windowMs) };
}

function useCeiling(
  values: readonly (number | null)[],
  tsMs: number,
  intervalMs: number,
  scope: string,
  floor: number
) {
  const held = useRef<{ scope: string; value: CeilingState } | null>(null);
  const max = values.reduce<number | null>(
    (peak, value) => (value === null ? peak : Math.max(peak ?? value, value)),
    null
  );
  const previous = held.current?.scope === scope ? held.current.value : null;
  const value = nextCeiling(previous, max, tsMs, {
    minCeiling: floor,
    maxTickGapMs: Math.max(10_000, 2 * intervalMs),
  });
  held.current = { scope, value };
  return value.ceiling;
}

function useLiveChartLabel(
  subject: string,
  windowMs: number,
  now: string | undefined,
  scope: string
) {
  const readAt = performance.now();
  const key = `${scope}:${subject}:${windowMs}`;
  const label = useRef({ key, now, readAt });
  if (
    label.current.key !== key ||
    !/[0-9]/.test(label.current.now ?? "") ||
    readAt - label.current.readAt >= 10_000
  ) {
    label.current = { key, now, readAt };
  }
  const figure = label.current.now;
  return `${subject}, ${spanWords(windowMs, null)}${figure === undefined ? "" : `, now ${figure}`}`;
}

export interface CompactStreamOptions {
  seriesKey: string;
  accent: Accent;
  subject: string;
  now?: string;
  height: number;
  yMax?: number;
  minCeiling?: number;
  bare?: boolean;
}

export function useCompactStream(
  host: HostId,
  {
    seriesKey,
    accent,
    subject,
    now,
    height,
    yMax,
    minCeiling = 10,
    bare = false,
  }: CompactStreamOptions
): StreamAreaData | null {
  const { state, windowMs, loading } = useLiveWindow(host, MINUTE_MS);
  const { values, tEndMs, intervalMs } = useMemo(
    () => seriesWindow(state, seriesKey, windowMs),
    [state, seriesKey, windowMs]
  );
  const auto = useCeiling(
    values,
    tEndMs,
    intervalMs,
    `${host}:${seriesKey}:${windowMs}:${minCeiling}`,
    minCeiling
  );
  const ariaLabel = useLiveChartLabel(
    subject,
    windowMs,
    now,
    `${host}:${seriesKey}`
  );
  if (state.lastTsMs === null && !loading) return null;
  const ceiling = yMax ?? auto;
  return {
    loading,
    series: [{ key: seriesKey, values, step: 1 }],
    tEndMs,
    intervalMs,
    yMax: ceiling,
    accent,
    height,
    ariaLabel,
    gridlines: bare ? [] : [ceiling / 2],
    ...(!bare && {
      ceilingLabel: `${ceiling}%`,
      windowLabel: windowLabel(windowMs),
    }),
  };
}

export function useNetworkBars(host: HostId): MirrorBarsData | null {
  const { state, windowMs, loading } = useLiveWindow(host, 48_000);
  const [up, down] = useMemo(
    () => [
      seriesWindow(state, "net.tx_total", windowMs),
      seriesWindow(state, "net.rx_total", windowMs),
    ],
    [state, windowMs]
  );
  const upMax = useCeiling(
    up.values,
    up.tEndMs,
    up.intervalMs,
    `${host}:${windowMs}`,
    100_000
  );
  const downMax = useCeiling(
    down.values,
    down.tEndMs,
    down.intervalMs,
    `${host}:${windowMs}`,
    100_000
  );
  if (state.lastTsMs === null && !loading) return null;
  return {
    loading,
    up: up.values,
    down: down.values,
    intervalMs: up.intervalMs,
    tEndMs: up.tEndMs,
    upMax,
    downMax,
    accent: "net",
    ariaLabel: `Network upload and download, ${spanWords(windowMs, null)}`,
  };
}
