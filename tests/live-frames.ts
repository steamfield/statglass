/**
 * Live-message builders for tests that drive the host store through the mock
 * transport (`transport.push`) or the reducer (`reduceLive`).
 */
import type { LiveMsg, MetricKind, SeriesKey } from "@core/generated/bindings";
import type { HostLive } from "@core/live-state";
import { act } from "@testing-library/react";

type Msg<K extends LiveMsg["kind"]> = Extract<LiveMsg, { kind: K }>;
export type FrameMsg = Msg<"frame">;
export type StatusMsg = Msg<"status">;

/** A sampling `status` at 1 s, running on an adapter; `over` replaces fields. */
export function statusMsg(over: Partial<Omit<StatusMsg, "kind">> = {}) {
  const msg: StatusMsg = {
    kind: "status",
    interval_ms: 1000,
    frame_period_ms: 1000,
    paused: false,
    display_idle: false,
    on_battery: false,
    performance: "off",
    power_source: "adapter",
    primary_iface: null,
    ...over,
  };
  return msg;
}

/** A `frame` on `layoutNo`; `held` defaults to `values`, `timeline` to 0. */
export function frameMsg(
  layoutNo: number,
  tsMs: number,
  values: (number | null)[],
  {
    held = values,
    timeline = 0,
  }: { held?: (number | null)[]; timeline?: number } = {}
): FrameMsg {
  return {
    kind: "frame",
    layout_no: layoutNo,
    timeline,
    ts_ms: tsMs,
    values,
    held,
  };
}

/**
 * Push layout `layoutNo` of `series` (every kind `gauge` unless `kinds` says
 * otherwise) and return a pusher for frames on it. Each push runs in `act()`.
 */
export function pushLayout(
  transport: { push(msg: LiveMsg): void },
  layoutNo: number,
  series: SeriesKey[],
  {
    kinds = series.map(() => "gauge"),
    timeline = 0,
  }: { kinds?: MetricKind[]; timeline?: number } = {}
) {
  act(() =>
    transport.push({ kind: "layout", layout_no: layoutNo, kinds, series })
  );
  return (tsMs: number, values: (number | null)[], held = values) =>
    act(() =>
      transport.push(frameMsg(layoutNo, tsMs, values, { held, timeline }))
    );
}

/**
 * The frame after the newest one in `state`: one second later, on its layout
 * and timeline, every series at its held value except `overrides`.
 */
export function nextFrame(
  state: HostLive,
  overrides: Record<string, number | null> = {}
): FrameMsg {
  const layoutNo = state.layoutNo;
  const layout = layoutNo === null ? undefined : state.layouts[layoutNo];
  if (layoutNo === null || !layout) throw new Error("no live layout");
  for (const k of Object.keys(overrides))
    if (!layout.index.has(k)) throw new Error(`${k} is not in the layout`);
  const values = layout.keys.map((k) =>
    k in overrides ? (overrides[k] ?? null) : (state.held[k] ?? null)
  );
  return frameMsg(layoutNo, (state.lastTsMs ?? 0) + 1000, values, {
    timeline: state.timeline ?? 0,
  });
}
