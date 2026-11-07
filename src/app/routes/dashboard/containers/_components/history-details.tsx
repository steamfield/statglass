import { formatDateTime } from "@core/format";
import type {
  DockerContainer,
  DockerCoverage,
  DockerCoverageKind,
} from "@core/generated/bindings";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "~/components/ui/dialog";

/** Rust's kind: lost events say nothing about measurements (D-128). */
export const eventCoverage = (gap: DockerCoverage) => gap.kind === "events";
/**
 * An engine-wide record that Rust says erases every container's measured time.
 * A container's own records show as that container's missing readings instead.
 */
export const masksEveryContainer = (gap: DockerCoverage) =>
  gap.container_id === null && gap.masking !== "none";
/**
 * One row per interruption: records of one reason and container that overlap or touch
 * merge. In start order only the scope's latest row can reach a record, so one pass
 * keyed by scope does it.
 */
export function mergeCoverage(
  records: readonly DockerCoverage[]
): DockerCoverage[] {
  const rows: DockerCoverage[] = [];
  const latest = new Map<string, DockerCoverage>();
  for (const record of [...records].sort((a, b) => a.start_ms - b.start_ms)) {
    const scope = `${record.reason}\u0000${record.container_id ?? "\u0001"}`;
    const previous = latest.get(scope);
    if (previous && (previous.end_ms ?? Infinity) >= record.start_ms) {
      previous.end_ms =
        previous.end_ms === null || record.end_ms === null
          ? null
          : Math.max(previous.end_ms, record.end_ms);
      continue;
    }
    const row = { ...record };
    rows.push(row);
    latest.set(scope, row);
  }
  return rows;
}
const SECTIONS: readonly { kind: DockerCoverageKind; title: string }[] = [
  { kind: "collection", title: "Collection" },
  { kind: "saving", title: "Saving" },
  { kind: "metrics", title: "Metrics" },
  { kind: "events", title: "Events" },
  { kind: "other", title: "Other" },
];
/** `records` are already merged (`mergeCoverage`); `unlisted` are the range's records Rust did not list. */
export function HistoryDetails({
  open,
  onOpenChange,
  records: merged,
  unlisted = 0,
  containers,
  savingError,
}: {
  savingError?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  records: readonly DockerCoverage[];
  unlisted?: number;
  containers: readonly DockerContainer[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>History details</DialogTitle>
        <DialogDescription>
          Collection, saving and coverage for this range.
        </DialogDescription>
        <div className="max-h-88 overflow-y-auto">
          {SECTIONS.map(({ kind, title }) => {
            const items = merged.filter((row) => row.kind === kind);
            return items.length ? (
              <section key={kind} className="mb-4">
                <h3 className="mb-2 text-[13px]">{title}</h3>
                {items.map((row, index) => (
                  <div
                    key={`${row.reason}:${row.container_id}:${row.start_ms}`}
                    className="border-border-subtle border-b py-2 text-[12px]"
                  >
                    <div>{row.label}</div>
                    {kind === "saving" && index === 0 && savingError && (
                      <p className="mt-1 break-words text-[12px] text-muted-foreground">
                        {savingError}
                      </p>
                    )}
                    <div className="text-[11px] text-muted-foreground">
                      {formatDateTime(row.start_ms)}–
                      {row.end_ms === null ? "now" : formatDateTime(row.end_ms)}{" "}
                      ·{" "}
                      {row.container_id === null
                        ? "All containers"
                        : row.container_id === ""
                          ? "Engine aggregate"
                          : (containers.find((c) => c.id === row.container_id)
                              ?.name ?? row.container_id)}
                    </div>
                    <code className="text-[11px] text-muted-foreground">
                      {row.reason}
                    </code>
                  </div>
                ))}
              </section>
            ) : null;
          })}
          {unlisted > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {unlisted} older {unlisted === 1 ? "record" : "records"} not
              listed
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
