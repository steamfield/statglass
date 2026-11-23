/**
 * Live process rows grouped by the app Rust assigned them (`LiveProcess.app`),
 * for the grouped process tables: group figures, search, and the running
 * processes a recorded app or process row acts on. Rust decides which app a
 * process belongs to and which members Quit acts on (`app_quit`); this module
 * only arranges and sums the rows a view shows.
 */
import { matchProcessQuery } from "@core/app-search";
import type { LiveProcess } from "./generated/bindings";

/** A group's figures: member sums, the ports union, and the user when shared. */
export interface LiveFigures {
  cpu_pct: number | null;
  mem_bytes: number;
  compressed_bytes: number | null;
  threads: number;
  idle_wakeups_per_s: number | null;
  energy: number | null;
  disk_read_bps: number | null;
  disk_write_bps: number | null;
  net_rx_bps: number | null;
  net_tx_bps: number | null;
  gpu_pct: number | null;
  /** Sorted and unique; null only when no member's ports were read. */
  ports: number[] | null;
  /** The members' user when they all share one, else null. */
  user: string | null;
}

/** One app on a live table. */
export interface LiveGroup {
  /** `app:<name>`, the selection and expansion key. */
  key: string;
  name: string;
  /** Every member, in input order. */
  members: readonly LiveProcess[];
  /** The members to list: all of them, or the ones a search matched. */
  shown: readonly LiveProcess[];
  /** The search matched members, not the app's name: list them open. */
  matchedInside: boolean;
  /** The members Quit on the app acts on (`app_quit`). */
  quit: readonly LiveProcess[];
  /** Over `shown`. */
  figures: LiveFigures;
}

/** Running processes by app name. */
export type RunningApps = ReadonlyMap<string, readonly LiveProcess[]>;

/** Sum of the values that were measured; null when none were. */
function sumMeasured(values: readonly (number | null)[]): number | null {
  if (values.every((v) => v === null)) return null;
  return values.reduce<number>((total, v) => total + (v ?? 0), 0);
}

/** The ports union, sorted and unique; null when no member's ports were read. */
function unionPorts(members: readonly LiveProcess[]): number[] | null {
  const read = members.flatMap((p) => (p.ports === null ? [] : [p.ports]));
  if (read.length === 0) return null;
  return [...new Set(read.flat())].sort((a, b) => a - b);
}

/** The user every member runs as, or null when they differ. */
function sharedUser(members: readonly LiveProcess[]): string | null {
  const [first] = members;
  if (first === undefined) return null;
  return members.every((p) => p.user === first.user) ? first.user : null;
}

/** The figures of a group over the members it lists. */
function sumFigures(members: readonly LiveProcess[]): LiveFigures {
  const sum = (pick: (p: LiveProcess) => number | null) =>
    sumMeasured(members.map(pick));
  return {
    cpu_pct: sum((p) => p.cpu_pct),
    mem_bytes: members.reduce((total, p) => total + p.mem_bytes, 0),
    compressed_bytes: sum((p) => p.compressed_bytes),
    threads: members.reduce((total, p) => total + p.threads, 0),
    idle_wakeups_per_s: sum((p) => p.idle_wakeups_per_s),
    energy: sum((p) => p.energy),
    disk_read_bps: sum((p) => p.disk_read_bps),
    disk_write_bps: sum((p) => p.disk_write_bps),
    net_rx_bps: sum((p) => p.net_rx_bps),
    net_tx_bps: sum((p) => p.net_tx_bps),
    gpu_pct: sum((p) => p.gpu_pct),
    ports: unionPorts(members),
    user: sharedUser(members),
  };
}

/** Rows by app name, apps in first-seen order and members in input order. */
function membersByApp(
  rows: readonly LiveProcess[]
): Map<string, LiveProcess[]> {
  const byApp = new Map<string, LiveProcess[]>();
  for (const row of rows) {
    const members = byApp.get(row.app);
    if (members === undefined) byApp.set(row.app, [row]);
    else members.push(row);
  }
  return byApp;
}

/** One group over its members, listing `shown` and summing over it. */
function buildGroup(
  name: string,
  members: readonly LiveProcess[],
  shown: readonly LiveProcess[],
  matchedInside: boolean
): LiveGroup {
  return {
    key: `app:${name}`,
    name,
    members,
    shown,
    matchedInside,
    quit: members.filter((p) => p.app_quit),
    figures: sumFigures(shown),
  };
}

/**
 * Groups rows by `app` in first-seen order. A search keeps a group whole
 * when its app name matches (case-insensitive substring), else keeps only
 * the members whose name, PID or port matches, and drops groups with none.
 */
export function groupLiveProcesses(
  rows: readonly LiveProcess[],
  query: string
): LiveGroup[] {
  const matches = matchProcessQuery(query);
  const groups: LiveGroup[] = [];
  for (const [name, members] of membersByApp(rows)) {
    if (!matches || matches({ name })) {
      groups.push(buildGroup(name, members, members, false));
      continue;
    }
    const inside = members.filter(matches);
    if (inside.length > 0) {
      groups.push(buildGroup(name, members, inside, true));
    }
  }
  return groups;
}

/** Every running process by app name, for rows that only know an app name. */
export function runningByApp(rows: readonly LiveProcess[]): RunningApps {
  return membersByApp(rows);
}

/**
 * What Quit on the app named `app` acts on right now: its running members
 * marked `app_quit`. Empty when the app is not running or the live rows have
 * not arrived.
 */
export function appQuitTargets(
  running: RunningApps | null,
  app: string
): readonly LiveProcess[] {
  return (running?.get(app) ?? []).filter((p) => p.app_quit);
}

/** The running process with this identity, or null when it has exited. */
export function runningTarget(
  running: RunningApps | null,
  p: Pick<LiveProcess, "pid" | "start_time_us">
): LiveProcess | null {
  if (running === null) return null;
  for (const members of running.values()) {
    const found = members.find(
      (q) => q.pid === p.pid && q.start_time_us === p.start_time_us
    );
    if (found !== undefined) return found;
  }
  return null;
}

/** Read plus write, bytes per second; null when either is unknown. */
export function diskTotal(
  p: Pick<LiveFigures, "disk_read_bps" | "disk_write_bps">
): number | null {
  if (p.disk_read_bps == null || p.disk_write_bps == null) return null;
  return p.disk_read_bps + p.disk_write_bps;
}

/** Received plus sent, bytes per second; null when either is unknown. */
export function netTotal(
  p: Pick<LiveFigures, "net_rx_bps" | "net_tx_bps">
): number | null {
  if (p.net_rx_bps == null || p.net_tx_bps == null) return null;
  return p.net_rx_bps + p.net_tx_bps;
}
