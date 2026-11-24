/**
 * `query_events` for the mock transport: a fixed day of detector and alert
 * events relative to `nowMs`. With the mock clock (Sun Oct 4, 22:40) the
 * fan ramp lands at 14:02 and the ANE spike 6.6 minutes before now, where
 * the power chart marks it.
 */
import { ALERT_LIMITS, type Event } from "@core/generated/types";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

/**
 * The `alerts` scenario's custom threshold alert, 72 minutes before `nowMs`:
 * memory pressure held above 80% for two minutes.
 */
function memoryPressureAlert(nowMs: number): Event {
  const firedMs = nowMs - (HOUR + 12 * MIN);
  return {
    ts_ms: firedMs,
    start_ms: firedMs - 2 * MIN,
    processes: [],
    detail: {
      kind: "alert",
      rule_id: "c0ffee00-0000-4000-8000-0000000000a1",
      rule_name: "Memory pressure above 80% for 2 min",
      cause: {
        type: "threshold",
        metric: "mem.pressure",
        labels: [],
        value: 86.4,
        op: "gt",
        threshold: 80,
        for_secs: 120,
      },
    },
  };
}

/** The built-in host-offline rule's id and the name its alerts carry. */
const HOST_OFFLINE_RULE = {
  rule_id: ALERT_LIMITS.host_offline_id,
  rule_name: "Saved host offline",
} as const;

/**
 * The `mac-offline` scenario's host-offline alerts: Studio Mac first seen
 * unreachable two hours before `nowMs`, reported offline five minutes
 * later, and back after 42 minutes.
 */
function hostOfflineAlerts(nowMs: number): Event[] {
  const sinceMs = nowMs - 2 * HOUR;
  const host = { host: "remote-studio", name: "Studio Mac" };
  return [
    {
      ts_ms: sinceMs + 5 * MIN,
      start_ms: sinceMs,
      processes: [],
      detail: {
        kind: "alert",
        ...HOST_OFFLINE_RULE,
        cause: { type: "host_offline", ...host },
      },
    },
    {
      ts_ms: sinceMs + 42 * MIN,
      start_ms: sinceMs,
      processes: [],
      detail: {
        kind: "alert",
        ...HOST_OFFLINE_RULE,
        cause: { type: "host_back", ...host, offline_secs: 42 * 60 },
      },
    },
  ];
}

/** Which scenarios' extra alerts `mockEvents` adds. */
export interface MockEventScenarios {
  /** The `alerts` scenario's custom threshold alert. */
  alerts?: boolean;
  /** The `mac-offline` scenario's host offline and back alerts. */
  hostOffline?: boolean;
}

/**
 * The fixed day of events ending at `nowMs`, oldest first. It always holds
 * a process alert; `scenarios` adds the `alerts` scenario's custom
 * threshold alert and the `mac-offline` scenario's host alerts.
 */
export function mockEvents(
  nowMs: number,
  scenarios: MockEventScenarios = {}
): Event[] {
  const at = (agoMs: number) => nowMs - agoMs;
  const scenarioAlerts = [
    ...(scenarios.alerts ? [memoryPressureAlert(nowMs)] : []),
    ...(scenarios.hostOffline ? hostOfflineAlerts(nowMs) : []),
  ].sort((a, b) => a.ts_ms - b.ts_ms);
  return [
    {
      ts_ms: at(12 * HOUR + 28 * MIN),
      start_ms: at(12 * HOUR + 31 * MIN),
      processes: ["com.docker.backend"],
      detail: {
        kind: "sustained_process",
        process: "com.docker.backend",
        cpu_pct: 142,
        secs: 180,
      },
    },
    {
      ts_ms: at(8 * HOUR + 38 * MIN),
      start_ms: at(8 * HOUR + 39 * MIN),
      processes: ["kernel_task", "Xcode build"],
      detail: { kind: "fans_ramped", from_rpm: 1450, to_rpm: 4210 },
    },
    {
      ts_ms: at(3 * HOUR + 20 * MIN),
      start_ms: at(3 * HOUR + 25 * MIN),
      processes: ["ffmpeg"],
      detail: {
        kind: "alert",
        rule_id: "6b656c76-6f00-0000-0000-000000000001",
        rule_name: "Process above 200% CPU for 5 minutes",
        cause: { type: "process_cpu", process: "ffmpeg", cpu_pct: 251 },
      },
    },
    ...scenarioAlerts,
    {
      ts_ms: at(6 * MIN + 36 * SEC),
      start_ms: at(6 * MIN + 50 * SEC),
      processes: ["Photos face analysis"],
      detail: {
        kind: "power_spike",
        component: "ane",
        watts: 1.4,
        baseline_watts: 0.1,
      },
    },
  ];
}
