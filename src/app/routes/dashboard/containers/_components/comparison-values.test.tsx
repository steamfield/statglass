import { formatPercent } from "@core/format";
import type { DockerCoverage } from "@core/generated/bindings";
import { mockContainer, mockHistoryPoints } from "@core/mock/docker";
import { render, screen, within } from "@testing-library/react";
import { ComparisonValues } from "./comparison-values";

const NOW = new Date(2026, 9, 4, 12, 0).getTime();
const FROM = NOW - 900_000;
const container = mockContainer(0, NOW);
const points = mockHistoryPoints(
  {
    engine_id: container.engine_id,
    container_id: container.id,
    from_ms: FROM,
    to_ms: NOW,
    max_points: 90,
  },
  container
);
const coverage = (
  start_ms: number,
  container_id: string | null
): DockerCoverage => ({
  start_ms,
  end_ms: start_ms + 60_000,
  container_id,
  reason: "engine_unreachable",
  kind: "collection",
  masking: container_id ? "containers" : "all",
  label: container_id ? "Container stopped" : "Docker unreachable",
});

describe("ComparisonValues", () => {
  it("names an engine-wide gap in time order and leaves a container's own gap to its cells", () => {
    render(
      <ComparisonValues
        series={[{ container, points, slot: 1 }]}
        times={points.map((p) => p.time_ms)}
        metric="cpu"
        gaps={[coverage(FROM + 300_000, null), coverage(FROM, container.id)]}
        from={FROM}
        to={NOW}
        bucketMs={10_000}
        displayName={(c) => c.name}
        format={(v) => formatPercent(v)}
      />
    );
    const table = screen.getByRole("table", {
      name: "Container history values",
    });
    expect(within(table).getByText("Docker unreachable")).toBeInTheDocument();
    expect(within(table).queryByText("Container stopped")).toBeNull();
    const times = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell")[0]?.textContent);
    // Oldest first, ten-second buckets with seconds.
    expect(times).toEqual([...times].sort());
    expect(times[0]).toMatch(/^\d\d:\d\d:\d\d$/);
  });

  it("lists only the engine-wide records Rust says mask the containers", () => {
    render(
      <ComparisonValues
        series={[{ container, points, slot: 1 }]}
        times={points.map((p) => p.time_ms)}
        metric="cpu"
        gaps={[
          // Engine-wide but masking nothing: saving, or an earlier build's
          // engine-wide partial cycle.
          {
            ...coverage(FROM + 60_000, null),
            masking: "none",
            label: "Not saved",
          },
          { ...coverage(FROM + 300_000, null), label: "Docker unreachable" },
        ]}
        from={FROM}
        to={NOW}
        bucketMs={10_000}
        displayName={(c) => c.name}
        format={(v) => formatPercent(v)}
      />
    );
    const table = screen.getByRole("table", {
      name: "Container history values",
    });
    expect(within(table).getByText("Docker unreachable")).toBeInTheDocument();
    expect(within(table).queryByText("Not saved")).toBeNull();
  });
});
