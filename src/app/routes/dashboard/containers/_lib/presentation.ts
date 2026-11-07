import { commandError, commandErrorText } from "@core/command-error";
import type {
  DockerContainer,
  DockerHealth,
  DockerLifecycle,
  DockerStatus,
} from "@core/generated/bindings";
import { historyUnavailable } from "@core/history-state";
import { remoteErrorText } from "@core/remote-errors";
import type { ColumnSort } from "~/components/data-table";
export const statusLabel: Record<DockerStatus, string> = {
  disabled: "Monitoring off",
  connecting: "Connecting",
  connected: "Connected",
  idle_suspended: "Paused · no running containers",
  paused: "Paused",
  unavailable: "Unavailable",
  permission_denied: "Socket permission denied",
  incompatible: "Incompatible engine API",
};
export const lifecycleLabel: Record<DockerLifecycle, string> = {
  created: "Created",
  running: "Running",
  paused: "Paused",
  restarting: "Restarting",
  exited: "Exited",
  removing: "Removing",
  dead: "Dead",
  removed: "Removed",
  unknown: "Unknown",
};
export const healthLabel: Record<DockerHealth, string> = {
  no_check: "No check",
  starting: "Starting",
  healthy: "Healthy",
  unhealthy: "Unhealthy",
  unknown: "Unknown",
};
export const CONTAINER_SORT_COLUMNS = [
  "cpu",
  "memory",
  "name",
  "restarts",
  "network",
  "io",
  "state",
  "image",
  "ports",
] as const;
export type ContainerSortColumn = (typeof CONTAINER_SORT_COLUMNS)[number];
export type ContainerSort = ColumnSort<ContainerSortColumn>;
export const DEFAULT_CONTAINER_SORT: ContainerSort = { by: "cpu", dir: "desc" };
const TEXT_COLUMNS: readonly ContainerSortColumn[] = [
  "name",
  "state",
  "image",
  "ports",
];
export const containerSortDescFirst = (by: ContainerSortColumn) =>
  !TEXT_COLUMNS.includes(by);
export const containerFirstDir = (by: ContainerSortColumn) =>
  containerSortDescFirst(by) ? "desc" : "asc";
export const isContainerSortColumn = (
  value: string
): value is ContainerSortColumn =>
  CONTAINER_SORT_COLUMNS.some((column) => column === value);
export const isLiveLifecycle = (row: DockerContainer) =>
  row.lifecycle === "running" ||
  row.lifecycle === "paused" ||
  row.lifecycle === "restarting";
export const containerPath = (engine: string, container: string) =>
  `/dashboard/containers/${encodeURIComponent(engine)}/${encodeURIComponent(container)}`;
export function cpuLeader(rows: readonly DockerContainer[]) {
  return rows.reduce<DockerContainer | undefined>((leader, row) => {
    if (!row.monitored || row.metrics.cpu_pct === null) return leader;
    if (!leader || row.metrics.cpu_pct > (leader.metrics.cpu_pct ?? -1))
      return row;
    return row.metrics.cpu_pct === leader.metrics.cpu_pct &&
      row.id.localeCompare(leader.id) < 0
      ? row
      : leader;
  }, undefined);
}
export function filterContainers(
  rows: readonly DockerContainer[],
  query: string,
  state: string
) {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter(
    (row) =>
      (state === "all" || row.lifecycle === state) &&
      `${row.name}\n${row.image}\n${row.project ?? ""}`
        .toLocaleLowerCase()
        .includes(needle)
  );
}

const DOCKER_FALLBACK = "Docker didn't answer. Try again.";

/**
 * Keep bounded, actionable errors supplied by Rust visible at the UI seam.
 * A kind without a message reads as the store or host problem it names;
 * only what is left says Docker didn't answer.
 */
export function dockerErrorMessage(error: unknown): string {
  const typed = commandError(error);
  if (typed === null || ("message" in typed && typed.message)) {
    return commandErrorText(error, DOCKER_FALLBACK);
  }
  const store = historyUnavailable(typed);
  if (store) return store.message;
  return typed.kind === "unknown_host" || typed.kind === "remote_host"
    ? remoteErrorText(typed)
    : DOCKER_FALLBACK;
}
