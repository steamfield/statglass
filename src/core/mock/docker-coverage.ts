import type {
  DockerCoverage,
  DockerCoverageKind,
  DockerCoverageMasking,
  DockerSnapshot,
} from "@core/generated/bindings";

/** Rust's `coverage_meaning`, for the reasons the mock publishes. */
const MEANING: Record<string, readonly [DockerCoverageKind, string]> = {
  shutdown: ["collection", "StatGlass was not running"],
  paused: ["collection", "Monitoring was paused"],
  idle_suspended: ["collection", "Monitoring paused while no containers ran"],
  unavailable: ["collection", "Docker is unavailable"],
  permission_denied: ["collection", "Docker refused access"],
  incompatible: ["collection", "This Docker version is not supported"],
  partial_population: [
    "collection",
    "Some running containers are not monitored",
  ],
  monitoring_paused: ["collection", "Monitoring is paused"],
  monitoring_idle: [
    "collection",
    "Monitoring is paused while no containers run",
  ],
  partial_cycle: ["metrics", "Some containers were not measured"],
  inventory_failed: ["metrics", "Docker did not list its containers"],
  clock_step: ["metrics", "The Mac's clock changed"],
  write_failed: ["saving", "Measurements could not be saved"],
  events_disconnected: ["events", "Lost connection to Docker events"],
};

/** Rust's `coverage_masking`. */
function masking(
  kind: DockerCoverageKind,
  scoped: boolean,
  reason: string
): DockerCoverageMasking {
  if (kind !== "collection" && kind !== "metrics") return "none";
  if (!scoped && reason === "partial_cycle") return "none";
  return scoped || reason === "inventory_failed" ? "containers" : "all";
}

/** `DockerCoverage::new` in Rust; an unknown reason is `other`, in words. */
export function mockCoverage(
  start_ms: number,
  end_ms: number | null,
  container_id: string | null,
  reason: string
): DockerCoverage {
  const words = reason.replaceAll("_", " ");
  const [kind, label] = MEANING[reason] ?? [
    "other",
    words.charAt(0).toUpperCase() + words.slice(1),
  ];
  return {
    start_ms,
    end_ms,
    container_id,
    reason,
    kind,
    masking: masking(kind, container_id !== null, reason),
    label,
  };
}

/** `DockerCoverage::masks` in Rust. */
export function mockMasks(
  g: DockerCoverage,
  containerId: string | null
): boolean {
  const scoped = g.container_id === null || g.container_id === containerId;
  if (g.masking === "none") return false;
  return g.masking === "containers" ? scoped && containerId !== null : scoped;
}

/** The current-state reason for each status that interrupts monitoring. */
const STATUS_REASON: Partial<Record<DockerSnapshot["status"], string>> = {
  unavailable: "unavailable",
  permission_denied: "permission_denied",
  incompatible: "incompatible",
  paused: "monitoring_paused",
  idle_suspended: "monitoring_idle",
};

/** `current_coverage` in Rust's `publication.rs`. */
export function currentCoverage(s: DockerSnapshot): DockerCoverage[] {
  const status = STATUS_REASON[s.status];
  const unmonitored =
    s.status === "connected" &&
    (s.aggregate.expected < s.aggregate.running ||
      !s.aggregate.inventory_complete);
  return [
    status,
    s.persistence.status === "write_failed" ? "write_failed" : undefined,
    unmonitored ? "partial_population" : undefined,
  ].flatMap((reason) =>
    reason ? [mockCoverage(s.observed_ms, null, null, reason)] : []
  );
}
