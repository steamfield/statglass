import { formatBytes } from "@core/format";
import type { SpaceHighlight } from "@core/generated/types";
import { MINUTE_MS } from "@core/time-grid";
import { useId } from "react";
import { Link } from "react-router";
import { ChartHistoryStatus } from "~/components/chart-history-status";
import { LargestFolderList } from "~/components/largest-folders";
import { Button } from "~/components/ui/button";
import { useRevealHighlight } from "~/hooks/use-disk-space";
import { useNow } from "~/hooks/use-now";
import { agoLabel } from "~/lib/time-ago";
import { Card } from "~/widgets/card";
import type { Corner } from "~/widgets/lib/accent";
import { useFolderReport } from "../_hooks/use-folder-report";

const ROWS = 5;
const SPACE = "/dashboard/disk-space?vol=/";

/**
 * The largest actionable folders of this Mac's last boot-volume scan (D-132):
 * the deepest folders where space sits, known locations named by what they
 * hold. Scanning is heavy, so it runs only when the user asks: Run report
 * the first time, Re-run after that. The summary outlives the scan, so later
 * visits show it with its age. A row shows the folder in Finder.
 */
export function OverviewFoldersCard({ origin }: { origin: Corner }) {
  const titleId = useId();
  // "Scanned 4 min ago" moves on while the dashboard stays open.
  const now = useNow(MINUTE_MS);
  const report = useFolderReport();
  const reveal = useRevealHighlight();
  const summary = report.summary.data;
  const error = report.error ?? reveal.error;

  return (
    <Card
      accent="disk"
      origin={origin}
      variant="chart"
      labelledBy={titleId}
      className="flex min-w-0 flex-col gap-3 px-4 py-3.5"
    >
      <header className="flex items-baseline justify-between gap-3">
        <h3 id={titleId} className="font-semibold text-body">
          <Link
            to={SPACE}
            className="rounded-control outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Largest folders
          </Link>
        </h3>
      </header>
      <FoldersBody report={report} onReveal={reveal.reveal} />
      {summary && report.progress === null && (
        <footer className="mt-auto flex items-center justify-between gap-3">
          <span className="text-label text-muted-foreground">
            Scanned {agoLabel(now, summary.finished_ms)}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={report.starting || report.busy}
            onClick={report.run}
          >
            Re-run
          </Button>
        </footer>
      )}
      {report.busy && (
        <p role="status" className="text-label text-muted-foreground">
          Another volume is being scanned in{" "}
          <Link to={SPACE} className="text-link hover:underline">
            Space
          </Link>
          . The report can run when it finishes.
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive text-label">
          {error}
        </p>
      )}
    </Card>
  );
}

function FoldersBody({
  report,
  onReveal,
}: {
  report: ReturnType<typeof useFolderReport>;
  onReveal: (folder: SpaceHighlight) => void;
}) {
  const summary = report.summary.data;
  if (report.progress !== null)
    return (
      <div className="flex items-center justify-between gap-3">
        <p role="status" className="figures text-muted-foreground text-small">
          Scanning this Mac's disk… {Math.round(report.progress * 100)}%
        </p>
        <Button variant="ghost" size="sm" onClick={report.cancel}>
          Cancel
        </Button>
      </div>
    );
  if (report.summary.isError)
    return (
      <p role="alert" className="text-muted-foreground text-small">
        Couldn't load the last report
      </p>
    );
  if (report.summary.isPending) return <ChartHistoryStatus loading />;
  if (!summary)
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-muted-foreground text-small">
          Find the folders taking the most space on this Mac. The report reads
          the whole disk, so it runs only when you ask.
        </p>
        <Button
          size="sm"
          disabled={report.starting || report.busy}
          onClick={report.run}
        >
          Run report
        </Button>
      </div>
    );
  if (summary.folders.length === 0)
    return (
      <p role="status" className="text-muted-foreground text-small">
        No folder holds {formatBytes(summary.min_bytes)} or more on its own.
      </p>
    );
  return (
    <LargestFolderList
      folders={summary.folders.slice(0, ROWS)}
      home={summary.home}
      onReveal={onReveal}
    />
  );
}
