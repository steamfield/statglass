import type { DockerHistoryPage } from "@core/generated/bindings";
import { mockContainer } from "@core/mock/docker";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ContainerHistory } from "./container-history";

it.each([true, false])(
  "renders Rust's covered flag (%s), independent of duration fields",
  (covered) => {
    const page = history(covered);
    const { container } = render(
      <ContainerHistory
        page={page}
        metric="cpu_pct"
        title="Coverage"
        from={0}
        to={10000}
      />
    );
    // One covered bucket is a run of one: a dot, never an invisible line.
    expect(container.querySelectorAll("[data-gap-edge]")).toHaveLength(
      covered ? 1 : 0
    );
  }
);

it("breaks the line at a skipped bucket and marks each edge with a hollow dot", () => {
  const page = history(true);
  const [first] = page.points;
  if (!first) throw new Error("no point");
  page.points = [0, 10_000, 30_000, 40_000].map((time_ms) => ({
    ...first,
    time_ms,
  }));
  const { container } = render(
    <ContainerHistory
      page={page}
      metric="cpu_pct"
      title="Two runs"
      from={0}
      to={50_000}
    />
  );
  const d = container.querySelector("[data-line]")?.getAttribute("d") ?? "";
  expect(d.match(/M/g)).toHaveLength(2);
  const dots = [...container.querySelectorAll<HTMLElement>("[data-gap-edge]")];
  expect(dots.map((dot) => dot.style.left)).toEqual(["20.000%", "60.000%"]);
});

it("drops a bucket Rust floored to before the range start, dot and fit", () => {
  const page = history(true);
  const [first] = page.points;
  if (!first) throw new Error("no point");
  page.points = [
    // A lone bucket starting 5 s before `from`, with a spike.
    { ...first, time_ms: -5_000, metrics: { ...first.metrics, cpu_pct: 140 } },
    ...[20_000, 30_000].map((time_ms) => ({
      ...first,
      time_ms,
      metrics: { ...first.metrics, cpu_pct: 10 },
    })),
  ];
  const { container } = render(
    <ContainerHistory
      page={page}
      metric="cpu_pct"
      title="Floored start"
      from={0}
      to={50_000}
    />
  );
  const dots = [...container.querySelectorAll<HTMLElement>("[data-gap-edge]")];
  expect(dots.map((dot) => dot.style.left)).toEqual([]);
  expect(screen.queryByText("150%")).toBeNull();
  expect(screen.getByText("11%")).toBeVisible();
});

function history(covered: boolean): DockerHistoryPage {
  return {
    generation: 1,
    coverage: [],
    coverage_total: 0,
    metadata: [],
    persistence: {
      error: null,
      status: "live_only",
      logical_bytes: 0,
      allowance_bytes: 1,
      retained_from_ms: null,
    },
    points: [
      {
        time_ms: 0,
        duration_ms: 10000,
        metrics: mockContainer(0, 0).metrics,
        cpu_measured_ms: covered ? 0 : 10000,
        memory_measured_ms: 0,
        peak: mockContainer(0, 0).metrics,
        minimum: mockContainer(0, 0).metrics,
        expected_ms: 10000,
        cpu_covered: covered,
        memory_covered: false,
        population_revision: 1,
        revision: 1,
        explicit_limit_bytes: null,
        engine_capacity_bytes: null,
      },
    ],
  };
}

it.each([
  { metric: "cpu_pct" as const, half: "0.05%" },
  { metric: "network_rx_bps" as const, half: "0.5 B/s" },
])(
  "labels a quiet $metric axis without rounding its midpoint to its maximum",
  ({ metric, half }) => {
    const page = history(true);
    page.points = page.points.map((point) => ({
      ...point,
      metrics: { ...point.metrics, [metric]: 0 },
    }));
    render(
      <ContainerHistory
        page={page}
        metric={metric}
        title="Quiet container"
        from={0}
        to={10000}
      />
    );
    expect(screen.getByText(half)).toBeVisible();
  }
);

it("fits the axis like the comparison chart, with a zero tick", () => {
  const page = history(true);
  page.points = page.points.map((point) => ({
    ...point,
    metrics: { ...point.metrics, cpu_pct: 140 },
  }));
  render(
    <ContainerHistory
      page={page}
      metric="cpu_pct"
      title="Busy container"
      from={0}
      to={10000}
    />
  );
  // 140% plus 5% headroom, rounded up on the two-significant-digit step.
  expect(screen.getByText("150%")).toBeVisible();
  expect(screen.getByText("75%")).toBeVisible();
  expect(screen.getByText("0")).toBeVisible();
});

it("fits the axis to the buckets it draws, not to uncovered ones", () => {
  const page = history(true);
  const [first] = page.points;
  if (!first) throw new Error("no point");
  page.points = [
    { ...first, metrics: { ...first.metrics, cpu_pct: 10 } },
    {
      ...first,
      time_ms: 10_000,
      cpu_covered: false,
      metrics: { ...first.metrics, cpu_pct: 140 },
    },
  ];
  render(
    <ContainerHistory
      page={page}
      metric="cpu_pct"
      title="Partial spike"
      from={0}
      to={20_000}
    />
  );
  expect(screen.queryByText("150%")).toBeNull();
  // 10% plus 5% headroom, on the two-significant-digit step.
  expect(screen.getByText("11%")).toBeVisible();
});
