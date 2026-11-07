import type { DockerContainer, DockerSnapshot } from "@core/generated/bindings";
import { HOUR_MS } from "@core/time-grid";
import { currentCoverage, mockCoverage } from "./docker-coverage";
import {
  aggregateContainers,
  mockContainer,
  mockDockerSnapshot,
} from "./docker-fixtures";
import type { ScenarioName } from "./fixtures";
export function retainedContainers(
  snapshot: DockerSnapshot,
  now: () => number
): DockerContainer[] {
  return [
    ...snapshot.containers,
    {
      ...mockContainer(0, now() - 60_000),
      id: "removed",
      name: "Removed worker",
      lifecycle: "removed" as const,
    },
    {
      ...mockContainer(2, now() - 60_000),
      id: "removed-spike",
      name: "retired-worker",
      project: "liveoak",
      lifecycle: "removed" as const,
    },
    {
      ...mockContainer(0, now() - HOUR_MS),
      engine_id: "retained-colima",
      id: "old-worker",
      name: "Previous worker",
    },
  ];
}
export function scenarioSnapshot(
  snapshot: DockerSnapshot,
  scenarios: readonly ScenarioName[],
  enabled: boolean,
  now: () => number
): DockerSnapshot {
  if (!enabled)
    snapshot = {
      ...snapshot,
      status: "disabled",
      engine: null,
      settings: { ...snapshot.settings, enabled: false },
      containers: [],
      aggregate: aggregateContainers([], now()),
      project_aggregates: [],
    };
  if (scenarios.includes("docker-unavailable"))
    snapshot = {
      ...snapshot,
      status: "unavailable",
      message:
        "The selected engine is unavailable. Its history is still available.",
    };
  if (scenarios.includes("docker-idle"))
    snapshot = {
      ...mockDockerSnapshot(0, now()),
      status: "idle_suspended",
      interval_ms: 0,
      population_revision: 0,
      runtime: {
        scope: "shared",
        explanation:
          "OrbStack shares its runtime with other workloads. Docker-only process attribution has not been verified.",
        cpu_pct: null,
        footprint_bytes: null,
        observed_ms: null,
        processes: [],
      },
      message: "No running containers. Monitoring paused to save power.",
    };
  if (scenarios.includes("docker-save-failed"))
    snapshot.persistence = {
      ...snapshot.persistence,
      status: "write_failed",
      error: "History storage is temporarily full",
    };
  if (scenarios.includes("docker-history-gap"))
    snapshot.coverage.push(
      mockCoverage(now() - 300_000, now() - 240_000, null, "shutdown")
    );
  if (scenarios.includes("docker-events-gap"))
    snapshot.coverage.push(
      mockCoverage(
        now() - 180_000,
        now() - 120_000,
        null,
        "events_disconnected"
      )
    );
  const first = snapshot.containers[0]?.id ?? null;
  if (scenarios.includes("docker-partial-cycle"))
    snapshot.coverage.push(
      // An earlier build's engine-wide record masks nothing; the container's own
      // does, and a failed inventory masks every container.
      mockCoverage(now() - 780_000, now() - 720_000, null, "partial_cycle"),
      mockCoverage(now() - 300_000, now() - 180_000, first, "partial_cycle"),
      mockCoverage(now() - 600_000, now() - 540_000, null, "inventory_failed")
    );
  if (scenarios.includes("docker-crash"))
    snapshot.coverage.push(
      // Left open by a crashed process; the restart closed both at its last reading.
      mockCoverage(now() - 420_000, now() - 400_000, first, "partial_cycle"),
      mockCoverage(now() - 420_000, now() - 400_000, null, "clock_step"),
      mockCoverage(now() - 400_000, now() - 330_000, null, "shutdown")
    );
  snapshot.current_coverage = currentCoverage(snapshot);
  return snapshot;
}
