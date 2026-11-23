/**
 * Live process rows grouped by the app Rust assigned them (`LiveProcess.app`),
 * for the grouped process tables: group figures, search, and the running
 * processes a recorded app or process row acts on. Rust decides which app a
 * process belongs to and which members Quit acts on (`app_quit`); this module
 * only arranges and sums the rows a view shows.
 */
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

/**
 * Groups rows by `app` in first-seen order. A search keeps a group whole
 * when its app name matches (case-insensitive substring), else keeps only
 * the members whose name, PID or port matches, and drops groups with none.
 */
export function groupLiveProcesses(
  rows: readonly LiveProcess[],
  query: string
): LiveGroup[] {
  void rows;
  void query;
  throw new Error("not implemented");
}

/** Every running process by app name, for rows that only know an app name. */
export function runningByApp(rows: readonly LiveProcess[]): RunningApps {
  void rows;
  throw new Error("not implemented");
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
  void running;
  void app;
  throw new Error("not implemented");
}

/** The running process with this identity, or null when it has exited. */
export function runningTarget(
  running: RunningApps | null,
  p: Pick<LiveProcess, "pid" | "start_time_us">
): LiveProcess | null {
  void running;
  void p;
  throw new Error("not implemented");
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
