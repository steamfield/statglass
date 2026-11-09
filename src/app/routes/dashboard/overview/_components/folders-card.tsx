import { commandErrorText } from "@core/command-error";
import { formatBytes } from "@core/format";
import type { SpaceCategory, SpaceHighlight } from "@core/generated/bindings";
import { MINUTE_MS } from "@core/time-grid";
import { useId, useState } from "react";
import { Link } from "react-router";
import { ChartHistoryStatus } from "~/components/chart-history-status";
import { Button } from "~/components/ui/button";
import { useNow } from "~/hooks/use-now";
import { useTransport } from "~/lib/transport-context";
import { agoLabel } from "~/routes/dashboard/disk/_lib/space";
import { Card } from "~/widgets/card";
import type { Corner } from "~/widgets/lib/accent";
import { useFolderReport } from "../_hooks/use-folder-report";

const ROWS = 5;
const SPACE = "/dashboard/disk?view=space&vol=/";

/** What each known location is, in the words people search for. */
const CATEGORY: Record<SpaceCategory, string> = {
  xcode_builds: "Xcode build data",
  xcode_archives: "Xcode archives",
  device_support: "Xcode device support",
  simulators: "iOS simulators",
  node_modules: "npm packages",
  caches: "App caches",
  trash: "Trash",
  container_data: "Container disk data",
  models: "Downloaded models",
  downloads: "Downloads",
};

/**
 * The largest actionable folders of this Mac's last boot-volume scan (D-132):
 * the deepest folders where space sits, known locations named by what they
 * hold. Scanning is heavy, so it runs only when the user asks: Run report
 * the first time, Re-run after that. The summary outlives the scan, so later
 * visits show it with its age. A row shows the folder in Finder.
 */
export function OverviewFoldersCard({ origin }: { origin: Corner }) {
  const titleId = useId();
  const transport = useTransport();
  // "Scanned 4 min ago" moves on while the dashboard stays open.
  const now = useNow(MINUTE_MS);
  const report = useFolderReport();
  const [revealError, setRevealError] = useState<string | null>(null);
  const summary = report.summary.data;
  const reveal = async (folder: SpaceHighlight) => {
    setRevealError(null);
    const result = await transport.diskSpaceRevealHighlight(folder.path);
    if (result.status === "error")
      setRevealError(
        commandErrorText(result.error, "Couldn't show this folder in Finder.")
      );
  };
  const error = report.error ?? revealError;

  return (
    <Card
      accent="disk"
      origin={origin}
      variant="chart"
      labelledBy={titleId}
      className="flex min-w-0 flex-col gap-3 px-4 py-3.5"
    >
      <header className="flex items-baseline justify-between gap-3">
        <h3 id={titleId} className="font-[590] text-[13px]">
          <Link
            to={SPACE}
            className="rounded-control outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Largest folders
          </Link>
        </h3>
      </header>
      <FoldersBody report={report} onReveal={(f) => void reveal(f)} />
      {summary && report.progress === null && (
        <footer className="mt-auto flex items-center justify-between gap-3">
          <span className="text-[11px] text-muted-foreground">
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
        <p role="status" className="text-[11px] text-muted-foreground">
          Another volume is being scanned in{" "}
          <Link to={SPACE} className="text-link hover:underline">
            Space
          </Link>
          . The report can run when it finishes.
        </p>
      )}
      {error && (
        <p role="alert" className="text-[11px] text-destructive">
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
        <p role="status" className="figures text-[12px] text-muted-foreground">
          Scanning this Mac's disk… {Math.round(report.progress * 100)}%
        </p>
        <Button variant="ghost" size="sm" onClick={report.cancel}>
          Cancel
        </Button>
      </div>
    );
  if (report.summary.isError)
    return (
      <p role="alert" className="text-[12px] text-muted-foreground">
        Couldn't load the last report
      </p>
    );
  if (report.summary.isPending) return <ChartHistoryStatus loading />;
  if (!summary)
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-[12px] text-muted-foreground">
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
      <p role="status" className="text-[12px] text-muted-foreground">
        No folder holds {formatBytes(summary.min_bytes)} or more on its own.
      </p>
    );
  return (
    <ul aria-label="Largest folders" className="flex flex-col gap-1">
      {summary.folders.slice(0, ROWS).map((folder) => (
        <li key={folder.path}>
          <FolderRow
            folder={folder}
            home={summary.home}
            onReveal={() => onReveal(folder)}
          />
        </li>
      ))}
    </ul>
  );
}

function FolderRow({
  folder,
  home,
  onReveal,
}: {
  folder: SpaceHighlight;
  home: string | null;
  onReveal: () => void;
}) {
  const { name, parent } = splitPath(folder.path, home);
  return (
    <button
      type="button"
      aria-description="Show in Finder"
      title={folder.path}
      className="flex w-full items-baseline justify-between gap-3 rounded-control py-1 text-left text-[12px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onReveal}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 text-fg-subtle">{name}</span>
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">
          {detail(folder, name, parent)}
        </span>
      </span>
      <span className="figures shrink-0 text-[11px] text-fg-subtle">
        {formatBytes(folder.bytes)}
      </span>
    </button>
  );
}

/** The category, unless it only repeats the name ("Downloads"); else the parent. */
function detail(folder: SpaceHighlight, name: string, parent: string) {
  const category = folder.category && CATEGORY[folder.category];
  return category && category !== name ? category : parent;
}

/**
 * "DerivedData" and "~/Library/Developer/Xcode" from an absolute path: only
 * this user's home reads as "~"; another account's folders keep their path.
 */
export function splitPath(
  path: string,
  home: string | null
): { name: string; parent: string } {
  const parts = path.split("/");
  const name = parts.pop() ?? path;
  const parent = parts.join("/") || "/";
  if (home && (parent === home || parent.startsWith(`${home}/`)))
    return { name, parent: `~${parent.slice(home.length)}` };
  return { name, parent };
}
