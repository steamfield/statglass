/**
 * Detector and alert events (v1.2, D-083): labels for the Timeline's pills
 * and the Power chart, and merging a pushed `event-recorded` into a list
 * already fetched.
 */
import type { TimeRange } from "@core/brush";
import { formatPercent } from "@core/format";
import type { Event, HostId, ThermalState } from "@core/generated/bindings";
import { ceilTo, floorTo, MINUTE_MS } from "@core/time-grid";

const THERMAL: Record<ThermalState, string> = {
  nominal: "Nominal",
  fair: "Fair",
  serious: "Serious",
  critical: "Critical",
};

const pct = (v: number | null) => (v === null ? "?" : formatPercent(v));
const watts = (v: number | null) => (v === null ? "?" : `${v.toFixed(1)} W`);

function duration(secs: number): string {
  return secs < 120 ? `${secs} s` : `${Math.round(secs / 60)} min`;
}

/** Process names joined with " + ": "kernel_task + Xcode build". */
function blame(processes: readonly string[]): string {
  return processes.length > 0 ? ` · ${processes.join(" + ")}` : "";
}

/**
 * What happened, without the time: "Fans ramped up · kernel_task + Xcode
 * build", "ANE 1.4 W · Photos face analysis".
 */
export function eventLabel(e: Event): string {
  const d = e.detail;
  switch (d.kind) {
    case "fans_ramped":
      return `Fans ramped up${blame(e.processes)}`;
    case "thermal_state":
      return `Thermal state ${THERMAL[d.to]}`;
    case "sustained_process":
      return `${d.process} at ${pct(d.cpu_pct)} CPU for ${duration(d.secs)}`;
    case "power_spike":
      return `${d.component === "ane" ? "ANE" : "Package"} ${watts(d.watts)}${blame(e.processes.slice(0, 1))}`;
    case "alert":
      return d.cause.type === "process_cpu"
        ? `Alert · ${d.cause.process} at ${pct(d.cause.cpu_pct)} CPU`
        : `Alert · thermal state ${THERMAL[d.cause.state]}`;
  }
}

/** Identity of a stored event: the store keeps one row per time and kind. */
export function eventId(e: Event): string {
  return `${e.detail.kind}@${e.ts_ms}`;
}

/**
 * `list` with `e` added in time order, or `list` itself when it already
 * holds it (a fetch that raced the push, or a second listener).
 */
export function mergeEvent(list: readonly Event[], e: Event): Event[] {
  const id = eventId(e);
  if (list.some((x) => eventId(x) === id)) return list as Event[];
  return [...list, e].sort((a, b) => a.ts_ms - b.ts_ms);
}

/**
 * Events pushed in the last `ttlMs`, per host. `event-recorded` goes out
 * once the commit is queued, not once it lands (D-083), so a read in that
 * window can answer without the event; merging these into every answer
 * covers it. `ttlMs` sits well above the writer's commit round trip, and
 * at most `max` events are kept per host.
 */
export class RecentEvents {
  readonly #byHost = new Map<HostId, { at: number; event: Event }[]>();
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #now: () => number;

  constructor(ttlMs = 10_000, max = 64, now: () => number = Date.now) {
    this.#ttlMs = ttlMs;
    this.#max = max;
    this.#now = now;
  }

  add(host: HostId, event: Event): void {
    const list = this.#live(host);
    list.push({ at: this.#now(), event });
    if (list.length > this.#max) list.shift();
  }

  /** `answer` with every recent event in `[fromMs, toMs)` merged in. */
  mergeInto(
    host: HostId,
    answer: readonly Event[],
    fromMs: number,
    toMs: number
  ): Event[] {
    let out = answer as Event[];
    for (const { event } of this.#live(host)) {
      if (event.ts_ms >= fromMs && event.ts_ms < toMs) {
        out = mergeEvent(out, event);
      }
    }
    return out;
  }

  #live(host: HostId): { at: number; event: Event }[] {
    const since = this.#now() - this.#ttlMs;
    const list = (this.#byHost.get(host) ?? []).filter((r) => r.at >= since);
    this.#byHost.set(host, list);
    return list;
  }
}

export function eventPriority(event: Event): number {
  const detail = event.detail;
  if (detail.kind === "alert") return 3;
  if (detail.kind === "thermal_state") {
    const states = ["nominal", "fair", "serious", "critical"];
    return states.indexOf(detail.to) > states.indexOf(detail.from ?? "") &&
      ["serious", "critical"].includes(detail.to)
      ? 3
      : 0;
  }
  return detail.kind === "fans_ramped" ? 1 : 2;
}

export function eventRange(
  events: readonly Event[],
  bucketMs: number,
  nowMs: number,
  retainedFrom = 0
) {
  if (events.length === 0) return null;
  const start = Math.min(
    ...events.map((event) => Math.min(event.start_ms, event.ts_ms))
  );
  const detection = Math.max(...events.map((event) => event.ts_ms));
  const padding =
    detection === start
      ? 300_000
      : Math.max(MINUTE_MS, (detection - start) * 0.2);
  return selectedRange(
    start - padding,
    detection + padding,
    bucketMs,
    nowMs,
    retainedFrom
  );
}

/** Selection follows displayed bucket edges, never inventing finer precision. */
export function selectedRange(
  a: number,
  b: number,
  bucketMs: number,
  nowMs: number,
  retainedFrom = 0
): TimeRange | null {
  const minimum = Math.max(MINUTE_MS, bucketMs);
  let fromMs = floorTo(Math.min(a, b), bucketMs);
  let toMs = ceilTo(Math.max(a, b), bucketMs);
  if (toMs - fromMs < minimum) toMs = fromMs + minimum;
  toMs = Math.min(toMs, nowMs);
  fromMs = Math.max(retainedFrom, Math.min(fromMs, toMs - minimum));
  return toMs - fromMs >= minimum ? { fromMs, toMs } : null;
}
