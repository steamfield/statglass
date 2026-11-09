import { formatBytes, formatDateTime, formatPercent } from "@core/format";
import type { DockerContainer } from "@core/generated/bindings";
import { MINUTE_MS } from "@core/time-grid";
import { InlineMessage } from "~/components/inline-message";
export function ContainerObservation({
  row,
  current,
  connection,
}: {
  row: DockerContainer;
  current: boolean;
  connection: string;
}) {
  return (
    <>
      {row.lifecycle === "removed" && (
        <InlineMessage tone="status">
          Removed container · retained history. Opening this page does not
          switch or reconnect the live engine.
        </InlineMessage>
      )}
      <p className="text-muted-foreground text-small">
        <span role="status">
          {connection} ·{" "}
          {current ? "Current observation" : "Retained observation"}
        </span>
        {" · "}
        {formatDateTime(row.observed_ms ?? row.last_seen_ms, {
          yearUnlessCurrent: true,
        })}
      </p>
      <div className="figures flex flex-wrap gap-x-6 gap-y-2 text-body">
        <span>
          {current ? "Now" : "Last observed"} · CPU{" "}
          {formatPercent(row.metrics.cpu_pct)}
        </span>
        <span>Working set {formatBytes(row.metrics.working_set_bytes)}</span>
        <span>
          Charged memory {formatBytes(row.metrics.raw_memory_bytes)} /{" "}
          {!row.metadata_available
            ? "Limit unavailable"
            : row.explicit_limit_bytes === null
              ? "No explicit limit"
              : formatBytes(row.explicit_limit_bytes)}
        </span>
      </div>
      <p className="text-label text-muted-foreground">
        Charged memory is used to assess an explicit limit; the charts show
        cache-adjusted working set.
      </p>
      {(row.oom_killed || row.observed_restarts > 0) && (
        <p
          role="status"
          className="rounded-control border border-border px-3 py-2 text-small"
        >
          {row.oom_killed ? "⚠ OOM recorded by Docker. " : ""}
          {row.repeated_restarts ? "Repeated restarts · " : ""}
          {row.observed_restarts} observed restarts in the last{" "}
          {row.observed_restart_window_ms / MINUTE_MS} minutes ·{" "}
          {row.restart_count ?? "Unknown"} cumulative Docker restarts. Exit code
          137 alone does not establish OOM.
        </p>
      )}
    </>
  );
}
