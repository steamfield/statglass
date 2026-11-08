import { commandErrorText } from "@core/command-error";
import { formatBytes } from "@core/format";
import type { SpaceCategory, SpaceHighlight } from "@core/generated/bindings";
import { diskSpaceKeys } from "@core/query-keys";
import { unwrap } from "@core/transport";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Link } from "react-router";
import { ChartHistoryStatus } from "~/components/chart-history-status";
import { useHostClock } from "~/lib/host-clock";
import { useTransport } from "~/lib/transport-context";
import { agoLabel } from "~/routes/dashboard/disk/_lib/space";
import { useHostId } from "~/stores/host-store";
import { Card } from "~/widgets/card";
import type { Corner } from "~/widgets/lib/accent";

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
 * The largest actionable folders of this Mac's last boot-volume scan (phase
 * 2b): the deepest folders where space sits, known locations named by what
 * they hold. The summary outlives the scan, so the card reads it without
 * scanning; a row shows the folder in Finder. This Mac only, like Reveal.
 */
export function OverviewFoldersCard({ origin }: { origin: Corner }) {
  const titleId = useId();
  const transport = useTransport();
  const host = useHostId();
  const clock = useHostClock();
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: diskSpaceKeys.highlights(host),
    queryFn: () => unwrap(transport.diskSpaceHighlights(host)),
  });
  const summary = query.data;
  const reveal = async (folder: SpaceHighlight) => {
    setError(null);
    const result = await transport.diskSpaceRevealHighlight(folder.path);
    if (result.status === "error")
      setError(
        commandErrorText(result.error, "Couldn't show this folder in Finder.")
      );
  };

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
        {summary && (
          <span className="text-[11px] text-muted-foreground">
            Scanned {agoLabel(clock(), summary.finished_ms)}
          </span>
        )}
      </header>
      {query.isError ? (
        <p role="alert" className="text-[12px] text-muted-foreground">
          Couldn't load the last scan
        </p>
      ) : query.isPending ? (
        <ChartHistoryStatus loading />
      ) : !summary ? (
        <p role="status" className="text-[12px] text-muted-foreground">
          <Link to={SPACE} className="text-link hover:underline">
            Scan this Mac's disk
          </Link>{" "}
          to see which folders take the most space.
        </p>
      ) : summary.folders.length === 0 ? (
        <p role="status" className="text-[12px] text-muted-foreground">
          No folder holds more than 1 GB on its own.
        </p>
      ) : (
        <ul aria-label="Largest folders" className="flex flex-col gap-1">
          {summary.folders.slice(0, ROWS).map((folder) => (
            <li key={folder.path}>
              <FolderRow folder={folder} onReveal={() => void reveal(folder)} />
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-[11px] text-destructive">
          {error}
        </p>
      )}
    </Card>
  );
}

function FolderRow({
  folder,
  onReveal,
}: {
  folder: SpaceHighlight;
  onReveal: () => void;
}) {
  const { name, parent } = splitPath(folder.path);
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

/** "DerivedData" and "~/Library/Developer/Xcode" from an absolute path. */
export function splitPath(path: string): { name: string; parent: string } {
  const parts = path.split("/");
  const name = parts.pop() ?? path;
  const parent = parts.join("/").replace(/^\/Users\/[^/]+/, "~");
  return { name, parent: parent || "/" };
}
