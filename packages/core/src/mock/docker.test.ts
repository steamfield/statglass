import { DOCKER_MAX_RANGE_MS } from "@core/generated/bindings";
import { createMockTransport } from "@core/mock-transport";
import { unwrap } from "@core/transport";
import { afterEach, expect, it, vi } from "vitest";
import { MOCK_DOCKER_ENGINE } from "./docker";

afterEach(() => vi.useRealTimers());
const request = {
  engine_id: MOCK_DOCKER_ENGINE,
  from_ms: 1_790_000_000_000,
  to_ms: 1_790_000_900_000,
  metric: "cpu" as const,
  project: null,
  selected: null,
  max_points: 360,
};

it("provides eleven containers, five measured, and shared realistic history", async () => {
  const t = createMockTransport({ scenarios: ["docker-11"], historyRows: 1 });
  const snapshot = await unwrap(t.dockerSnapshot());
  expect(snapshot.containers).toHaveLength(11);
  expect(snapshot.aggregate.running).toBe(5);
  expect(snapshot.containers.slice(0, 5).map((row) => row.name)).toEqual([
    "api",
    "worker",
    "caddy",
    "grafana-dev",
    "tempo",
  ]);
  const comparison = await unwrap(t.dockerComparison(request));
  expect(comparison.series).toHaveLength(5);
  expect(
    comparison.ranking.filter((row) => row.container.lifecycle === "removed")
  ).toHaveLength(2);
  const first = comparison.series.find(
    (row) => row.container.id === "container-0"
  );
  expect(first).toBeDefined();
  if (!first) throw new Error("No mock series");
  const history = await unwrap(
    t.dockerHistory({ ...request, container_id: first.container.id })
  );
  expect(first.points).toEqual(history.points);
  expect(first.points.some((p) => p.cpu_measured_ms === 9999)).toBe(true);
  expect(first.points.filter((p) => !p.cpu_covered)).toHaveLength(2);
  expect(
    first.points.some(
      (p, i) =>
        i > 0 &&
        p.time_ms - (first.points[i - 1]?.time_ms ?? p.time_ms) > 10_000
    )
  ).toBe(true);
  t.dispose();
});

it("refuses Docker history, events and comparisons longer than Rust's cap", async () => {
  const t = createMockTransport({ scenarios: ["docker-11"], historyRows: 1 });
  const tooLong = {
    ...request,
    from_ms: request.to_ms - DOCKER_MAX_RANGE_MS - 1,
    container_id: null,
    limit: 200,
    before_id: null,
  };
  const refused = {
    status: "error",
    error: {
      kind: "invalid_argument",
      message: "the range is longer than 30 days",
    },
  };
  expect(await t.dockerComparison(tooLong)).toEqual(refused);
  expect(await t.dockerHistory(tooLong)).toEqual(refused);
  expect(await t.dockerEvents(tooLong)).toEqual(refused);
  const full = { ...tooLong, from_ms: request.to_ms - DOCKER_MAX_RANGE_MS };
  expect((await t.dockerHistory(full)).status).toBe("ok");
  expect((await t.dockerEvents(full)).status).toBe("ok");
  t.dispose();
});

it("bounds comparison requests and retains removed history only in the first half", async () => {
  const t = createMockTransport({ scenarios: ["docker-11"], historyRows: 1 });
  expect(
    (
      await t.dockerComparison({
        ...request,
        selected: Array.from({ length: 7 }, (_, i) => `container-${i}`),
      })
    ).status
  ).toBe("error");
  expect(
    (await t.dockerComparison({ ...request, max_points: 361 })).status
  ).toBe("error");
  const page = await unwrap(
    t.dockerComparison({
      ...request,
      project: "liveoak",
      selected: ["removed-spike"],
    })
  );
  expect(page.ranking.every((row) => row.container.project === "liveoak")).toBe(
    true
  );
  expect(page.series).toHaveLength(1);
  expect(
    page.series[0]?.points.every((p) => p.time_ms < request.from_ms + 450_000)
  ).toBe(true);
  const rolled = await unwrap(
    t.dockerComparison({
      ...request,
      from_ms: request.to_ms - 86_400_000,
      max_points: 360,
    })
  );
  expect(
    rolled.series.some((row) =>
      row.points.some(
        (p) => (p.peak.cpu_pct ?? 0) === (p.metrics.cpu_pct ?? 0) * 3
      )
    )
  ).toBe(true);
  t.dispose();
});

it("serializes row and storage operations, changes lifecycle after 500 ms, and preserves failure messages", async () => {
  vi.useFakeTimers();
  const t = createMockTransport({ scenarios: ["docker-11"], historyRows: 1 });
  const op = await unwrap(
    t.dockerContainerAction(MOCK_DOCKER_ENGINE, "container-0", "stop")
  );
  expect(op.finished_ms).toBeNull();
  expect(
    (await t.dockerContainerAction(MOCK_DOCKER_ENGINE, "container-1", "stop"))
      .status
  ).toBe("error");
  expect(
    (
      await t.dockerStoragePrepare([
        { kind: "volume", id: "old-database-data", action: "delete" },
      ])
    ).status
  ).toBe("error");
  await vi.advanceTimersByTimeAsync(500);
  expect((await unwrap(t.dockerSnapshot())).containers[0]?.lifecycle).toBe(
    "exited"
  );
  const start = await unwrap(
    t.dockerContainerAction(MOCK_DOCKER_ENGINE, "container-0", "start")
  );
  await vi.advanceTimersByTimeAsync(500);
  expect(
    (await unwrap(t.dockerStorageOperation(start.id))).results[0]?.status
  ).toBe("succeeded");
  await t.dockerContainerAction(MOCK_DOCKER_ENGINE, "container-1", "stop");
  await vi.advanceTimersByTimeAsync(500);
  const worker = await unwrap(
    t.dockerContainerAction(MOCK_DOCKER_ENGINE, "container-1", "start")
  );
  await vi.advanceTimersByTimeAsync(500);
  expect(
    (await unwrap(t.dockerStorageOperation(worker.id))).results[0]
  ).toMatchObject({ status: "failed", message: "Port 8080 is already in use" });
  t.dispose();
});

it("keeps collection and container state when only display preferences change", async () => {
  vi.useFakeTimers();
  const t = createMockTransport({ scenarios: ["docker-11"], historyRows: 1 });
  await t.dockerContainerAction(MOCK_DOCKER_ENGINE, "container-0", "stop");
  await vi.advanceTimersByTimeAsync(500);
  const before = await unwrap(t.dockerSnapshot());
  const settings = {
    ...before.settings,
    show_popover: !before.settings.show_popover,
    show_tray_count: !before.settings.show_tray_count,
  };
  const after = await unwrap(t.dockerConfigure(settings));
  expect(after.generation).toBe(before.generation);
  expect(after.containers).toEqual(before.containers);
  expect(after.aggregate).toEqual(before.aggregate);
  expect(after.settings).toEqual(settings);
  expect((await t.getSettings()).settings.docker).toEqual(settings);
  t.dispose();
});

it("counts no measured time inside a collection gap, as Rust does (D-128)", async () => {
  const t = createMockTransport({
    scenarios: ["docker-11", "docker-history-gap", "docker-events-gap"],
    historyRows: 1,
  });
  const snapshot = await unwrap(t.dockerSnapshot());
  const gap = snapshot.coverage.find((g) => g.kind === "collection");
  const events = snapshot.coverage.find((g) => g.kind === "events");
  if (!gap?.end_ms || !events?.end_ms) throw new Error("No mock gaps");
  const range = {
    ...request,
    from_ms: gap.start_ms - 600_000,
    to_ms: gap.end_ms + 600_000,
  };
  const comparison = await unwrap(t.dockerComparison(range));
  const first = comparison.series.find((s) => s.container.id === "container-0");
  if (!first) throw new Error("No mock series");
  const inside = (from: number, to: number) =>
    first.points.filter(
      (p) => p.time_ms >= from && p.time_ms + p.duration_ms <= to
    );
  expect(inside(gap.start_ms, gap.end_ms).length).toBeGreaterThan(0);
  for (const p of inside(gap.start_ms, gap.end_ms)) {
    expect([p.cpu_measured_ms, p.cpu_covered]).toEqual([0, false]);
  }
  // Lost events say nothing about measurements.
  expect(
    inside(events.start_ms, events.end_ms).some((p) => p.cpu_measured_ms > 0)
  ).toBe(true);
  const history = await unwrap(
    t.dockerHistory({ ...range, container_id: first.container.id })
  );
  expect(history.points).toEqual(first.points);
  t.dispose();
});

it("masks a partial cycle for its own container only, as Rust does", async () => {
  const t = createMockTransport({
    scenarios: ["docker-11", "docker-partial-cycle"],
    historyRows: 1,
  });
  const snapshot = await unwrap(t.dockerSnapshot());
  const [global, own] = snapshot.coverage;
  if (!global?.end_ms || !own?.end_ms) throw new Error("No mock gaps");
  expect([global.container_id, own.container_id]).toEqual([
    null,
    "container-0",
  ]);
  const range = {
    ...request,
    from_ms: global.start_ms - 60_000,
    to_ms: own.end_ms + 60_000,
  };
  const comparison = await unwrap(t.dockerComparison(range));
  const series = (id: string) =>
    comparison.series.find((s) => s.container.id === id)?.points ?? [];
  const inside = (id: string, from: number, to: number) =>
    series(id).filter(
      (p) => p.time_ms >= from && p.time_ms + p.duration_ms <= to
    );
  expect(
    inside("container-0", own.start_ms, own.end_ms).length
  ).toBeGreaterThan(0);
  expect(
    inside("container-0", own.start_ms, own.end_ms).every(
      (p) => p.cpu_measured_ms === 0
    )
  ).toBe(true);
  expect(
    inside("container-1", own.start_ms, own.end_ms).every(
      (p) => p.cpu_measured_ms > 0
    )
  ).toBe(true);
  expect(
    inside("container-0", global.start_ms, global.end_ms).every(
      (p) => p.cpu_measured_ms > 0
    )
  ).toBe(true);
  const inventory = snapshot.coverage.find(
    (g) => g.reason === "inventory_failed"
  );
  if (!inventory?.end_ms) throw new Error("No failed inventory");
  expect(inventory.masking).toBe("containers");
  // No container claims measured time inside it (the mock leaves fully masked
  // buckets out); the buckets around it still do.
  expect(
    inside("container-1", inventory.start_ms - 30_000, inventory.start_ms)
      .length
  ).toBeGreaterThan(0);
  for (const id of ["container-0", "container-1"])
    expect(
      inside(id, inventory.start_ms, inventory.end_ms).every(
        (p) => p.cpu_measured_ms === 0
      )
    ).toBe(true);
  t.dispose();
});

it("derives the current-state records on every publish, as Rust does", async () => {
  const t = createMockTransport({
    scenarios: ["docker-11", "docker-unavailable", "docker-save-failed"],
  });
  const snapshot = await unwrap(t.dockerSnapshot());
  expect(
    snapshot.current_coverage.map((g) => [g.reason, g.kind, g.end_ms])
  ).toEqual([
    ["unavailable", "collection", null],
    ["write_failed", "saving", null],
  ]);
  const resumed = await unwrap(t.dockerResume());
  expect(resumed.current_coverage.map((g) => g.reason)).toEqual([
    "write_failed",
  ]);
  t.dispose();
});
