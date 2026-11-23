import type { LiveProcess } from "@core/generated/bindings";
import { type RunningApps, runningByApp } from "@core/process-groups";
import { FULL_TABLE } from "@core/process-interest";
import { useMemo } from "react";
import { useCanSignal } from "~/hooks/use-edition";
import { useProcessInterest } from "~/hooks/use-process-interest";
import { useHost, useHostStore } from "~/stores/host-store";

/** Each batch's membership key, so a selector rerun on the same batch is free. */
const keys = new WeakMap<readonly LiveProcess[], string>();

/**
 * What the running map depends on: each row's app, identity and whether
 * Quit on its app acts on it. Figures change every second; this rarely does.
 */
function membershipKey(rows: readonly LiveProcess[]): string {
  let key = keys.get(rows);
  if (key === undefined) {
    key = rows
      .map((p) => `${p.app}\u0000${p.pid}:${p.start_time_us}:${p.app_quit}`)
      .join("\u0001");
    keys.set(rows, key);
  }
  return key;
}

/**
 * Every running process by app name, for tables whose rows only know an app
 * name or a recorded process (recorded ranges, Network). Asks for the full
 * process table while mounted, and only where this view can quit processes.
 * Null when it cannot, and before the first batch. The map keeps its
 * identity while no process starts, exits or changes app, so a table that
 * reads it does not re-render each second.
 */
export function useRunningApps(): RunningApps | null {
  const canSignal = useCanSignal();
  useProcessInterest(canSignal ? FULL_TABLE : null);
  const store = useHostStore();
  const key = useHost((s) =>
    canSignal && s.processes ? membershipKey(s.processes.rows) : null
  );
  return useMemo(() => {
    if (key === null) return null;
    return runningByApp(store.getState().processes?.rows ?? []);
  }, [key, store]);
}
