/**
 * Mock Docker scenarios: the snapshot each `docker-*` scenario starts from,
 * including the unreachable-engine states Rust reports through `availability`,
 * and the snapshots a runtime launch moves through.
 */
import type {
  DockerContainer,
  DockerRuntimeApp,
  DockerRuntimeKind,
  DockerSnapshot,
  DockerStatus,
  DockerUnavailableReason,
} from "@core/generated/types";
import { HOUR_MS, MINUTE_MS } from "@core/time-grid";
import { currentCoverage, mockCoverage } from "./docker-coverage";
import {
  aggregateContainers,
  engine,
  mockContainer,
  mockDockerSnapshot,
  projectAggregates,
} from "./docker-fixtures";
import type { ScenarioName } from "./fixtures";

/** Runtimes Rust can find on a Mac, by kind, as `installed_runtimes` reports them. */
export const MOCK_RUNTIMES: Readonly<
  Record<DockerRuntimeKind, DockerRuntimeApp>
> = {
  docker_desktop: {
    kind: "docker_desktop",
    name: "Docker Desktop",
    launchable: true,
  },
  orb_stack: { kind: "orb_stack", name: "OrbStack", launchable: true },
  rancher_desktop: {
    kind: "rancher_desktop",
    name: "Rancher Desktop",
    launchable: true,
  },
  colima: { kind: "colima", name: "Colima", launchable: false },
};

/** How long the mock engine takes to answer after its app is opened. */
export const MOCK_LAUNCH_DELAY_MS = 3_000;
/** Rust's post-launch window of fast retries. */
const LAUNCH_WINDOW_MS = 60_000;
/** When the mock's next automatic connection attempt falls. */
const NEXT_ATTEMPT_MS = 8_000;

/** One unreachable-engine scenario: the status Rust publishes and why. */
interface EngineScenario {
  readonly status: DockerStatus;
  readonly reason: DockerUnavailableReason | null;
  readonly runtimes: readonly DockerRuntimeKind[];
  /** Keeps the engine identity, as Rust does when the socket answered but refused. */
  readonly keepsEngine: boolean;
  readonly retainsHistory: boolean;
}

const ENGINE_SCENARIOS: Partial<Record<ScenarioName, EngineScenario>> = {
  "docker-not-installed": unreachable("not_installed", [], false),
  "docker-not-running": unreachable("not_running", ["docker_desktop"], false),
  "docker-stopped": unreachable("stopped", ["docker_desktop"], true),
  "docker-choose-engine": unreachable(
    "choose_engine",
    ["docker_desktop", "orb_stack"],
    false
  ),
  "docker-colima": unreachable("not_running", ["colima"], false),
  "docker-permission-denied": refused("permission_denied"),
  "docker-incompatible": refused("incompatible"),
};

function unreachable(
  reason: DockerUnavailableReason,
  runtimes: readonly DockerRuntimeKind[],
  retainsHistory: boolean
): EngineScenario {
  const status = "unavailable";
  return { status, reason, runtimes, keepsEngine: false, retainsHistory };
}

function refused(status: DockerStatus): EngineScenario {
  return {
    status,
    reason: null,
    runtimes: [],
    keepsEngine: true,
    retainsHistory: false,
  };
}

/** The first engine-state scenario requested, applied to a fresh snapshot. */
function engineScenario(
  snapshot: DockerSnapshot,
  scenarios: readonly ScenarioName[],
  nowMs: number
): DockerSnapshot {
  const name = scenarios.find((scenario) => ENGINE_SCENARIOS[scenario]);
  const scenario = name ? ENGINE_SCENARIOS[name] : undefined;
  if (!scenario) return snapshot;
  return {
    ...snapshot,
    status: scenario.status,
    engine: scenario.keepsEngine ? snapshot.engine : null,
    containers: [],
    aggregate: aggregateContainers([], nowMs),
    project_aggregates: [],
    persistence: {
      ...snapshot.persistence,
      retained_from_ms: scenario.retainsHistory
        ? snapshot.persistence.retained_from_ms
        : null,
    },
    availability:
      scenario.reason === null
        ? null
        : {
            reason: scenario.reason,
            runtimes: scenario.runtimes.map((kind) => MOCK_RUNTIMES[kind]),
            next_attempt_ms: nowMs + NEXT_ATTEMPT_MS,
            launching_until_ms: null,
          },
  };
}

/** The snapshot right after a runtime app was opened: still unreachable, retrying fast. */
export function launchingSnapshot(
  snapshot: DockerSnapshot,
  nowMs: number
): DockerSnapshot {
  if (snapshot.availability === null) return snapshot;
  return {
    ...snapshot,
    availability: {
      ...snapshot.availability,
      launching_until_ms: nowMs + LAUNCH_WINDOW_MS,
    },
  };
}

/** The snapshot once the launched engine answers: connected with its containers. */
export function launchedSnapshot(
  snapshot: DockerSnapshot,
  containers: DockerContainer[],
  nowMs: number
): DockerSnapshot {
  return {
    ...snapshot,
    status: "connected",
    message: null,
    engine,
    containers,
    aggregate: aggregateContainers(containers, nowMs, snapshot.interval_ms),
    project_aggregates: projectAggregates(
      containers,
      nowMs,
      snapshot.interval_ms
    ),
    availability: null,
    observed_ms: nowMs,
  };
}
export function retainedContainers(
  snapshot: DockerSnapshot,
  now: () => number
): DockerContainer[] {
  return [
    ...snapshot.containers,
    {
      ...mockContainer(0, now() - MINUTE_MS),
      id: "removed",
      name: "Removed worker",
      lifecycle: "removed" as const,
    },
    {
      ...mockContainer(2, now() - MINUTE_MS),
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
      availability: {
        reason: "not_running",
        runtimes: [MOCK_RUNTIMES.docker_desktop],
        next_attempt_ms: now() + NEXT_ATTEMPT_MS,
        launching_until_ms: null,
      },
    };
  snapshot = engineScenario(snapshot, scenarios, now());
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
