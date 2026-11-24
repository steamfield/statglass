/**
 * What the running processes offer a table whose rows only know an app name
 * or a recorded process (usage, recorded ranges, Network): each listed app's
 * quit targets, and the live match of each listed process. Both ask for the
 * full process table while mounted, only where this view can quit, and keep
 * their answer's identity until the listed rows' part of it changes, so a
 * process starting or exiting elsewhere on the Mac re-renders nothing.
 */
import type { LiveProcess, ProcessView } from "@core/generated/types";
import {
  appQuitTargets,
  type RunningApps,
  runningByApp,
} from "@core/process-groups";
import { FULL_TABLE } from "@core/process-interest";
import { targetKey } from "@core/process-selection";
import { useRef } from "react";
import { useCanSignal } from "~/hooks/use-edition";
import { useProcessInterest } from "~/hooks/use-process-interest";
import { useHost, useHostStore } from "~/stores/host-store";

/**
 * What the running map asks for: every process, every 10 s. Quit targets may
 * be that stale (the per-target results report a process that exited), and
 * a page that wants the table each second (Processes) still wins the union.
 */
export const RUNNING_APPS_VIEW: ProcessView = {
  ...FULL_TABLE,
  period_ms: 10_000,
};

/**
 * Why a row that only knows an app or a recorded process offers no Quit:
 * nothing it names is running. Shown only once a live batch is known.
 */
export const NOT_RUNNING = "Not running";

/** Each listed app's quit targets, by app name. */
export type AppQuitTargets = ReadonlyMap<string, readonly LiveProcess[]>;

/** Each listed process that is running, by `targetKey` (pid and start time). */
export type RunningMatches = ReadonlyMap<string, LiveProcess>;

/** A derived answer and the string it changes with. */
interface Keyed<T> {
  key: string;
  value: T;
}

/** Each batch's running map, so the selector rerun on one batch is free. */
const maps = new WeakMap<readonly LiveProcess[], RunningApps>();

function runningOf(rows: readonly LiveProcess[]): RunningApps {
  let running = maps.get(rows);
  if (running === undefined) {
    running = runningByApp(rows);
    maps.set(rows, running);
  }
  return running;
}

/** Each batch's processes by identity, for matching recorded processes. */
const identities = new WeakMap<
  readonly LiveProcess[],
  ReadonlyMap<string, LiveProcess>
>();

function byIdentity(
  rows: readonly LiveProcess[]
): ReadonlyMap<string, LiveProcess> {
  let found = identities.get(rows);
  if (found === undefined) {
    found = new Map(rows.map((p) => [targetKey(p), p]));
    identities.set(rows, found);
  }
  return found;
}

/**
 * `derive`'s answer over the latest process batch. The store selector only
 * returns the answer's key, so the caller renders when the key changes and
 * not on every batch; the answer is rebuilt then and held until it changes
 * again. Null where this view cannot quit and before the first batch.
 */
function useRunningDerived<T>(
  derive: (rows: readonly LiveProcess[]) => Keyed<T>
): T | null {
  const canSignal = useCanSignal();
  useProcessInterest(canSignal ? RUNNING_APPS_VIEW : null);
  const store = useHostStore();
  const key = useHost((s) =>
    canSignal && s.processes ? derive(s.processes.rows).key : null
  );
  const held = useRef<Keyed<T> | null>(null);
  if (key === null) {
    held.current = null;
    return null;
  }
  // Written during render, like the grouped table's held order: the same key
  // gives the same answer on every render.
  if (held.current?.key !== key) {
    held.current = derive(store.getState().processes?.rows ?? []);
  }
  return held.current.value;
}

/**
 * What Quit on each of `names` acts on in the live batch (`appQuitTargets`),
 * by name; an app with nothing running maps to an empty list. Null where
 * this view cannot quit and before the first batch.
 */
export function useAppQuitTargets(
  names: readonly string[]
): AppQuitTargets | null {
  return useRunningDerived((rows) => {
    const running = runningOf(rows);
    const value = new Map(names.map((n) => [n, appQuitTargets(running, n)]));
    const key = [...value]
      .map(([name, list]) => `${name}\u0000${list.map(targetKey).join(",")}`)
      .join("\u0001");
    return { key, value };
  });
}

/**
 * The running process of each of `processes` with the same pid and start
 * time, by `targetKey`; one that has exited is absent. Null where this view
 * cannot quit and before the first batch.
 */
export function useRunningMatches(
  processes: readonly Pick<LiveProcess, "pid" | "start_time_us">[]
): RunningMatches | null {
  return useRunningDerived((rows) => {
    const live = byIdentity(rows);
    const value = new Map<string, LiveProcess>();
    for (const p of processes) {
      const match = live.get(targetKey(p));
      if (match !== undefined) value.set(targetKey(match), match);
    }
    return { key: [...value.keys()].join(","), value };
  });
}
