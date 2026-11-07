import { formatDateTime } from "@core/format";
import type { DockerCoverage, DockerSnapshot } from "@core/generated/bindings";
import { useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import {
  eventCoverage,
  HistoryDetails,
  mergeCoverage,
} from "./history-details";

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Controller and presentation split tracked in architecture refactor package H.
export function HistoryNotice({
  snapshot,
  coverage,
  total = coverage.length,
  plotted,
  metric,
  onManage,
  onResume,
}: {
  snapshot: DockerSnapshot;
  coverage: readonly DockerCoverage[];
  /** How many records the range holds; Rust lists the newest. */
  total?: number | undefined;
  /** The charted containers: only their own records and engine-wide ones count. */
  plotted: readonly string[];
  metric: "cpu" | "memory";
  onManage: () => void;
  onResume: () => void;
}) {
  const [open, setOpen] = useState(false);
  const records = useMemo(() => mergeCoverage(coverage), [coverage]);
  // The banner and the details read the snapshot's persistence, through Rust's
  // current-state records; one interruption in both lists shows once.
  const current = snapshot.current_coverage;
  const details = useMemo(
    () => mergeCoverage([...coverage, ...current]),
    [coverage, current]
  );
  const persistence = snapshot.persistence;
  const unavailable = [
    "unavailable",
    "permission_denied",
    "incompatible",
  ].includes(snapshot.status);
  const paused = ["paused", "idle_suspended"].includes(snapshot.status);
  const saving = persistence.status === "write_failed";
  // Missing history is what Rust says masks the charted points.
  const gaps = records.filter(
    (record) =>
      record.masking !== "none" &&
      (record.container_id === null || plotted.includes(record.container_id))
  );
  const partial = current.some(
    (record) => record.reason === "partial_population"
  );
  const events = records.some(eventCoverage);
  const matches = [
    unavailable,
    paused,
    saving,
    gaps.length > 0,
    partial,
    events,
  ].filter(Boolean).length;
  if (!matches) return null;
  const observations = snapshot.containers.flatMap((row) =>
    row.observed_ms === null ? [] : [row.observed_ms]
  );
  const latest = observations.length
    ? Math.max(...observations)
    : snapshot.observed_ms;
  const runtime = snapshot.engine?.runtime ?? "Engine";
  const text = unavailable
    ? saving
      ? `${runtime} unavailable; recent history not saved`
      : `${runtime} unavailable · last reading ${formatDateTime(latest)}`
    : paused
      ? "Monitoring paused"
      : saving
        ? "Recent history is not being saved. StatGlass will retry."
        : gaps.length
          ? `${metric === "cpu" ? "CPU" : "Memory"} history missing for ${gaps.length} ${gaps.length === 1 ? "interval" : "intervals"}`
          : partial
            ? `Monitoring ${snapshot.aggregate.expected} of ${snapshot.aggregate.running} running containers`
            : "Some container events may be missing";
  return (
    <>
      <div
        role="status"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground"
      >
        <span className="flex-1">{text}</span>
        {(unavailable || paused || partial) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={unavailable || paused ? onResume : onManage}
          >
            {unavailable ? "Retry" : paused ? "Resume" : "Monitoring…"}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          Details ({details.length})
        </Button>
      </div>
      <HistoryDetails
        open={open}
        onOpenChange={setOpen}
        savingError={saving ? persistence.error : null}
        records={details}
        unlisted={Math.max(0, total - coverage.length)}
        containers={snapshot.containers}
      />
    </>
  );
}
