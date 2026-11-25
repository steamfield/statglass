import { formatBytes } from "@core/format";
import type { SpaceCategory, SpaceHighlight } from "@core/generated/types";

/**
 * The largest actionable folders of a boot-volume scan (D-132) as a list of
 * rows: the folder's name, what it is or where it sits, and its size. A row
 * shows the folder in Finder. The Overview card and the Disk space landing
 * state both show the kept summary this way.
 */
export function LargestFolderList({
  folders,
  home,
  onReveal,
}: {
  folders: readonly SpaceHighlight[];
  /** The user's home folder, so paths under it read from "~". */
  home: string | null;
  onReveal: (folder: SpaceHighlight) => void;
}) {
  return (
    <ul aria-label="Largest folders" className="flex flex-col gap-1">
      {folders.map((folder) => (
        <li key={folder.path}>
          <FolderRow
            folder={folder}
            home={home}
            onReveal={() => onReveal(folder)}
          />
        </li>
      ))}
    </ul>
  );
}

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
      className="flex w-full items-baseline justify-between gap-3 rounded-control py-1 text-left text-small outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onReveal}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate text-fg-subtle">{name}</span>
        <span className="min-w-0 truncate text-label text-muted-foreground">
          {detail(folder, name, parent)}
        </span>
      </span>
      <span className="figures shrink-0 text-fg-subtle text-label">
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
