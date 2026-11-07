import type {
  DockerCoverage,
  DockerCoverageKind,
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
  partial_cycle: ["metrics", "Some containers were not measured"],
  clock_step: ["metrics", "The Mac's clock changed"],
  write_failed: ["saving", "Measurements could not be saved"],
  events_disconnected: ["events", "Lost connection to Docker events"],
};

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
  return { start_ms, end_ms, container_id, reason, kind, label };
}

/** `current_coverage` in Rust's `publication.rs`. */
export function currentCoverage(s: DockerSnapshot): DockerCoverage[] {
  const status = (
    [
      "unavailable",
      "permission_denied",
      "incompatible",
      "paused",
      "idle_suspended",
    ] as const
  ).find((key) => key === s.status);
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
