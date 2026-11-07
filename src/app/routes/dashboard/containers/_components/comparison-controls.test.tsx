import { formatDateTime } from "@core/format";
import {
  mockContainer,
  mockCoverage,
  mockDockerSnapshot,
  mockHistoryPoints,
} from "@core/mock/docker";
import { fireEvent, screen, within } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vitest";
import { useSeriesFocus } from "~/hooks/use-series-focus";
import { ChartChooser } from "./chart-chooser";
import { ComparisonChart } from "./comparison-chart";
import { mergeCoverage } from "./history-details";
import { HistoryNotice } from "./history-notice";
import { MonitoringDialog } from "./monitoring-dialog";

/** The route owns focus; tests own it here the same way. */
function FocusedChart(
  props: Omit<ComponentProps<typeof ComparisonChart>, "focus">
) {
  const focus = useSeriesFocus();
  return <ComparisonChart {...props} focus={focus} />;
}

it("blocks a seventh chart choice and never changes recording", async () => {
  const candidates = Array.from({ length: 7 }, (_, i) => ({
    ...mockContainer(i, 1000),
    name: `container ${i}`,
  }));
  const change = vi.fn();
  const result = renderWithProviders(
    <ChartChooser
      open
      onOpenChange={() => {}}
      candidates={candidates}
      liveRows={candidates}
      selected={candidates.slice(0, 6).map((row) => row.id)}
      slots={{}}
      metric="cpu"
      onChange={change}
      onAutomatic={() => {}}
    />
  );
  expect(
    screen.getByRole("checkbox", { name: "Chart container 6" })
  ).toBeDisabled();
  expect(
    screen.getByText("Remove a container to compare another.")
  ).toBeVisible();
  await result.user.click(
    screen.getByRole("checkbox", { name: "Chart container 0" })
  );
  expect(change).toHaveBeenCalledWith(
    candidates.slice(1, 6).map((row) => row.id)
  );
  result.unmount();
  result.transport.dispose();
});

it("labels comparison gap bands with Rust's label, never the reason key", () => {
  const container = mockContainer(0, 3_600_000);
  const result = renderWithProviders(
    <FocusedChart
      series={[{ container, points: [], slot: 1 }]}
      metric="cpu"
      from={0}
      to={3_600_000}
      live={false}
      range="1h"
      coverage={[
        {
          start_ms: 600_000,
          end_ms: 900_000,
          container_id: null,
          reason: "shutdown",
          kind: "collection",
          masking: "all",
          label: "StatGlass was not running",
        },
        {
          start_ms: 1_200_000,
          end_ms: 1_500_000,
          container_id: null,
          reason: "events_dropped_rate_limit",
          kind: "events",
          masking: "none",
          label: "Events arrived too fast; some were dropped",
        },
      ]}
      onChoose={() => {}}
    />
  );
  expect(screen.getByLabelText("StatGlass was not running")).toBeTruthy();
  expect(screen.queryByLabelText("shutdown")).toBeNull();
  // Event coverage is not a metric gap.
  expect(
    screen.queryByLabelText("Events arrived too fast; some were dropped")
  ).toBeNull();
  result.unmount();
  result.transport.dispose();
});

it("groups history details by Rust's kind", async () => {
  const snapshot = mockDockerSnapshot(1, 30000);
  const result = renderWithProviders(
    <HistoryNotice
      snapshot={snapshot}
      coverage={[
        {
          start_ms: 0,
          end_ms: 10000,
          container_id: null,
          reason: "events_dropped_rate_limit",
          kind: "events",
          masking: "none",
          label: "Events arrived too fast; some were dropped",
        },
      ]}
      metric="cpu"
      onManage={() => {}}
      onResume={() => {}}
    />
  );
  expect(
    screen.getByText("Some container events may be missing")
  ).toBeVisible();
  await result.user.click(screen.getByRole("button", { name: /Details/ }));
  const dialog = screen.getByRole("dialog", { name: "History details" });
  expect(within(dialog).getByRole("heading", { name: "Events" })).toBeVisible();
  expect(
    within(dialog).getByText("Events arrived too fast; some were dropped")
  ).toBeVisible();
  result.unmount();
  result.transport.dispose();
});

it("merges touching equal-scope coverage without merging events into metrics", () => {
  const records = mergeCoverage([
    {
      start_ms: 0,
      end_ms: 10000,
      container_id: "a",
      reason: "write_failed",
      kind: "saving",
      masking: "none",
      label: "Measurements could not be saved",
    },
    {
      start_ms: 10000,
      end_ms: 20000,
      container_id: "a",
      reason: "write_failed",
      kind: "saving",
      masking: "none",
      label: "Measurements could not be saved",
    },
    {
      start_ms: 0,
      end_ms: 20000,
      container_id: null,
      reason: "events_disconnected",
      kind: "events",
      masking: "none",
      label: "Lost connection to Docker events",
    },
    {
      start_ms: 10000,
      end_ms: 20000,
      container_id: "b",
      reason: "write_failed",
      kind: "saving",
      masking: "none",
      label: "Measurements could not be saved",
    },
  ]);
  expect(records).toHaveLength(3);
  expect(records.find((r) => r.container_id === "a")?.end_ms).toBe(20000);
});

it("shows one prioritized notice and separates metrics from events in details", async () => {
  const snapshot = mockDockerSnapshot(1, 30000);
  const result = renderWithProviders(
    <HistoryNotice
      snapshot={{
        ...snapshot,
        status: "unavailable",
        persistence: {
          ...snapshot.persistence,
          status: "write_failed",
          error: "Database is locked; close the other writer and retry.",
        },
        current_coverage: [
          mockCoverage(30000, null, null, "unavailable"),
          mockCoverage(30000, null, null, "write_failed"),
        ],
      }}
      coverage={[
        {
          start_ms: 0,
          end_ms: 10000,
          container_id: null,
          reason: "events_disconnected",
          kind: "events",
          masking: "none",
          label: "Lost connection to Docker events",
        },
      ]}
      metric="cpu"
      onManage={() => {}}
      onResume={() => {}}
    />
  );
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(
    screen.getByText("OrbStack unavailable; recent history not saved")
  ).toBeVisible();
  await result.user.click(screen.getByRole("button", { name: /Details/ }));
  const dialog = screen.getByRole("dialog", { name: "History details" });
  expect(
    within(dialog).getByText("Measurements could not be saved")
  ).toBeVisible();
  expect(
    within(dialog).getByText(
      "Database is locked; close the other writer and retry."
    )
  ).toBeVisible();
  expect(
    within(dialog).getByText("Lost connection to Docker events")
  ).toBeVisible();
  result.unmount();
  result.transport.dispose();
});

it("lists the current-state records Rust publishes, in Rust's words", async () => {
  const snapshot = mockDockerSnapshot(1, 30000);
  const result = renderWithProviders(
    <HistoryNotice
      snapshot={{
        ...snapshot,
        aggregate: { ...snapshot.aggregate, running: 2 },
        current_coverage: [
          {
            ...mockCoverage(30000, null, null, "partial_population"),
            label: "Wording from Rust",
          },
        ],
      }}
      coverage={[]}
      metric="cpu"
      onManage={() => {}}
      onResume={() => {}}
    />
  );
  await result.user.click(screen.getByRole("button", { name: "Details (1)" }));
  const dialog = screen.getByRole("dialog", { name: "History details" });
  expect(within(dialog).getByText("Wording from Rust")).toBeVisible();
  expect(
    within(dialog).queryByText("Some running containers are not monitored")
  ).toBeNull();
  result.unmount();
  result.transport.dispose();
});

it("explains automatic engine inventory collection and saves display preferences immediately", async () => {
  const snapshot = mockDockerSnapshot(11, 30000);
  const configure = vi.fn(async () => true);
  const result = renderWithProviders(
    <MonitoringDialog
      snapshot={snapshot}
      onChange={() => {}}
      onClose={() => {}}
      configure={configure}
    />
  );
  expect(screen.queryByRole("radio", { name: "Choose containers" })).toBeNull();
  expect(screen.queryByRole("checkbox", { name: /^Monitor / })).toBeNull();
  expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  expect(
    screen.getByRole("heading", { name: "Automatic collection" })
  ).toBeVisible();
  expect(screen.getByText(/up to 128 at a time/)).toBeVisible();
  expect(configure).not.toHaveBeenCalled();
  await result.user.click(
    screen.getByRole("checkbox", { name: "Show in popover" })
  );
  expect(configure).toHaveBeenCalledWith({ show_popover: true });
  result.unmount();
  result.transport.dispose();
});

it("provides partial values, interval min/avg/max, keyboard focus and pinned detail links", async () => {
  const container = mockContainer(0, 86_400_000);
  const points = mockHistoryPoints(
    {
      engine_id: container.engine_id,
      container_id: container.id,
      from_ms: 0,
      to_ms: 86_400_000,
      max_points: 360,
    },
    container
  );
  const result = renderWithProviders(
    <FocusedChart
      series={[{ container, points, slot: 1 }]}
      metric="cpu"
      from={0}
      to={86_400_000}
      live={false}
      range="24h"
      onChoose={() => {}}
    />
  );
  const chart = screen.getByRole("img", { name: /CPU by container/ });
  expect(chart.querySelectorAll("ellipse").length).toBeGreaterThan(0);
  const brush = screen.getByRole("slider", { name: "Select a time range" });
  fireEvent.keyDown(brush, { key: "ArrowLeft" });
  fireEvent.keyDown(brush, { key: "Enter" });
  expect(screen.getByRole("tooltip")).toHaveTextContent("min / avg / max");
  const link = within(screen.getByRole("tooltip")).getByRole("link");
  expect(link.getAttribute("href")).toContain("metric=cpu&range=15m&end=");
  fireEvent.focus(screen.getByRole("button", { name: container.name }));
  // Keyboard focus on the legend previews the line: it draws at 2 px.
  expect(chart.querySelector('path[stroke-width="2"]')).not.toBeNull();
  await result.user.click(
    screen.getByRole("button", { name: "Show as table" })
  );
  expect(
    screen.getByRole("table", { name: "Container history values" })
  ).toHaveTextContent("partial");
  result.unmount();
  result.transport.dispose();
});

it("keeps the unavailable last-reading time at the newest measured container observation", () => {
  const snapshot = mockDockerSnapshot(2, 90_000);
  const measured = 20_000;
  const result = renderWithProviders(
    <HistoryNotice
      snapshot={{
        ...snapshot,
        status: "unavailable",
        observed_ms: 90_000,
        containers: snapshot.containers.map((row, index) => ({
          ...row,
          observed_ms: index ? measured : 10_000,
        })),
      }}
      coverage={[]}
      metric="cpu"
      onManage={() => {}}
      onResume={() => {}}
    />
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    `last reading ${formatDateTime(measured)}`
  );
  result.unmount();
  result.transport.dispose();
});

it("reads the population notice from Rust's current records, as the details do", () => {
  // A cycle that missed a container is partial, but every running container is
  // monitored: Rust publishes no partial_population record, so neither says so.
  const snapshot = mockDockerSnapshot(3, 30_000);
  const result = renderWithProviders(
    <HistoryNotice
      snapshot={{
        ...snapshot,
        aggregate: {
          ...snapshot.aggregate,
          expected: 3,
          running: 3,
          cpu_measured: 2,
          partial: true,
        },
        current_coverage: [],
      }}
      coverage={[]}
      metric="cpu"
      onManage={() => {}}
      onResume={() => {}}
    />
  );
  expect(screen.queryByRole("status")).toBeNull();
  result.unmount();
  result.transport.dispose();
});

it.each([0, 3])(
  "reports %s active collectors against the current running population",
  (expected) => {
    const snapshot = mockDockerSnapshot(11, 30_000);
    const result = renderWithProviders(
      <HistoryNotice
        snapshot={{
          ...snapshot,
          aggregate: {
            ...snapshot.aggregate,
            monitored: 9,
            expected,
            running: 5,
            partial: true,
          },
          current_coverage: [
            mockCoverage(30_000, null, null, "partial_population"),
          ],
        }}
        coverage={[]}
        metric="cpu"
        onManage={() => {}}
        onResume={() => {}}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      `Monitoring ${expected} of 5 running containers`
    );
    expect(
      screen.queryByText("Monitoring 9 of 5 running containers")
    ).toBeNull();
    result.unmount();
    result.transport.dispose();
  }
);
