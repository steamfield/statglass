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
export function mergeCoverage(
  records: readonly DockerCoverage[]
): DockerCoverage[] {
  const rows: DockerCoverage[] = [];
  for (const record of [...records].sort((a, b) => a.start_ms - b.start_ms)) {
    const previous = [...rows]
      .reverse()
      .find(
        (r) =>
          r.reason === record.reason &&
          r.container_id === record.container_id &&
          (r.end_ms ?? Infinity) >= record.start_ms
      );
    if (previous)
      previous.end_ms =
        previous.end_ms === null || record.end_ms === null
          ? null
          : Math.max(previous.end_ms, record.end_ms);
    else rows.push({ ...record });
  }
  return rows;
}
const SECTIONS: readonly { kind: DockerCoverageKind; title: string }[] = [
  { kind: "collection", title: "Collection" },
  { kind: "saving", title: "Saving" },
  { kind: "metrics", title: "Metrics" },
  { kind: "events", title: "Events" },
];
export function HistoryDetails({
  open,
  onOpenChange,
  records,
  containers,
  savingError,
}: {
  savingError?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  records: readonly DockerCoverage[];
  containers: readonly DockerContainer[];
}) {
  const merged = mergeCoverage(records);
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
