import { rangeScopeWords } from "@core/brush";
import { formatBytes, formatPercent } from "@core/format";
import {
  DOCKER_BUCKET_MS,
  type DockerComparisonMetric,
  type DockerRankedContainer,
} from "@core/generated/bindings";
import { dockerKeys } from "@core/query-keys";
import { floorTo } from "@core/time-grid";
import { unwrap } from "@core/transport";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Link } from "react-router";
import { ChartHistoryStatus } from "~/components/chart-history-status";
import { SegmentedControl } from "~/components/segmented-control";
import { useModuleEnd } from "~/hooks/use-module-end";
import { useTransport } from "~/lib/transport-context";
import { useDockerComparison } from "~/routes/dashboard/containers/_hooks/use-docker-comparison";
import {
  containerPath,
  statusLabel,
} from "~/routes/dashboard/containers/_lib/presentation";
import { Card } from "~/widgets/card";
import type { Corner } from "~/widgets/lib/accent";

const ROWS = 5;
const METRICS = [
  { value: "cpu", label: "CPU" },
  { value: "memory", label: "Memory" },
] as const;

/**
 * The containers that peaked highest over the chart window, by CPU or
 * working-set memory, with the running count now (phase 2b). It asks the
 * Containers page's ranking query for the window with no charted series,
 * and orders rows the way that page does: by peak. Shown only on This Mac
 * with Docker monitoring on; storage and cleanup stay on the page, because
 * reading them runs a Docker disk scan (D-107).
 */
export function OverviewContainersCard({
  windowMs,
  origin,
}: {
  windowMs: number;
  origin: Corner;
}) {
  const titleId = useId();
  const [metric, setMetric] = useState<DockerComparisonMetric>("cpu");
  const transport = useTransport();
  // A read every Docker bucket, not the live stream: a stream from a shown
  // window moves the Docker worker to its 1 s visible cadence, and the card
  // needs only the engine, its generation, its clock and the running count.
  const docker = useQuery({
    queryKey: dockerKeys.snapshot(),
    queryFn: () => unwrap(transport.dockerSnapshot()),
    // Faster while the engine is still connecting, so the card follows it in.
    refetchInterval: (q) =>
      q.state.data?.status === "connecting" ? 1000 : DOCKER_BUCKET_MS,
  });
  const snapshot = docker.data ?? null;
  const engine = snapshot?.engine?.id ?? "";
  const endMs = useModuleEnd();
  // Docker keeps its own clock; the window ends at its open 10 s bucket,
  // as on the Containers page, so the query key moves once per bucket.
  const toMs = endMs ?? floorTo(snapshot?.now_ms ?? 0, DOCKER_BUCKET_MS);
  const comparison = useDockerComparison(
    {
      engine_id: engine,
      from_ms: toMs - windowMs,
      to_ms: toMs,
      metric,
      project: null,
      selected: [],
      max_points: 60,
    },
    snapshot?.generation ?? 0
  );
  const scope = rangeScopeWords(windowMs, endMs);
  const ranked = (comparison.data?.ranking ?? []).filter(
    (row) => peak(row, metric) !== null
  );

  return (
    <Card
      accent="cpu"
      origin={origin}
      variant="chart"
      labelledBy={titleId}
      className="flex min-w-0 flex-col gap-3 px-4 py-3.5"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h3 id={titleId} className="font-semibold text-body">
            <Link
              to="/dashboard/containers"
              className="rounded-control outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              Containers
            </Link>
          </h3>
          {snapshot && (
            <span className="figures truncate text-label text-muted-foreground">
              {snapshot.status === "connected" ||
              snapshot.status === "idle_suspended"
                ? `${snapshot.aggregate.running} running`
                : statusLabel[snapshot.status]}
            </span>
          )}
        </div>
        <SegmentedControl
          options={METRICS}
          value={metric}
          onChange={setMetric}
          ariaLabel="Rank containers by"
        />
      </header>
      <ContainersBody
        error={
          docker.isError
            ? "Couldn't read Docker"
            : comparison.isError
              ? "Couldn't load container history"
              : null
        }
        noEngine={
          snapshot !== null &&
          !engine &&
          snapshot.status !== "connecting" &&
          snapshot.status !== "disabled"
        }
        loading={docker.isPending || !engine || comparison.isPending}
        ranked={ranked}
        metric={metric}
        scope={scope}
      />
    </Card>
  );
}

function ContainersBody({
  error,
  noEngine,
  loading,
  ranked,
  metric,
  scope,
}: {
  error: string | null;
  noEngine: boolean;
  loading: boolean;
  ranked: DockerRankedContainer[];
  metric: DockerComparisonMetric;
  scope: string;
}) {
  if (error)
    return (
      <p role="alert" className="text-muted-foreground text-small">
        {error}
      </p>
    );
  if (noEngine)
    return (
      <p role="status" className="text-muted-foreground text-small">
        No Docker engine to read containers from.
      </p>
    );
  if (loading) return <ChartHistoryStatus loading />;
  if (ranked.length === 0)
    return (
      <p role="status" className="text-muted-foreground text-small">
        No container activity {scope}
      </p>
    );
  return (
    <>
      <p className="text-label text-muted-foreground">
        {metric === "cpu" ? "Peak CPU" : "Peak memory"}
      </p>
      <ul aria-label="Busiest containers" className="flex flex-col gap-1">
        {ranked.slice(0, ROWS).map((row) => (
          <li key={row.container.id}>
            <Link
              to={containerPath(row.container.engine_id, row.container.id)}
              className="flex w-full items-baseline justify-between gap-3 rounded-control py-1 text-fg-subtle text-small outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="min-w-0 truncate" title={row.container.name}>
                {row.container.name}
              </span>
              <span className="figures shrink-0 text-label">
                {metric === "cpu"
                  ? formatPercent(row.peak_cpu_pct)
                  : formatBytes(row.peak_working_set_bytes)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

function peak(row: DockerRankedContainer, metric: DockerComparisonMetric) {
  return metric === "cpu" ? row.peak_cpu_pct : row.peak_working_set_bytes;
}
