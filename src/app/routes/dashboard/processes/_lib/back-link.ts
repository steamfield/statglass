/**
 * Where the process detail page's back link goes and what it says. Any
 * table that links a process here passes its own path and query as `back`.
 */

/** Without a usable `back`, the page returns to Disk, its first caller. */
const DEFAULT_BACK = "/dashboard/disk";

/** Page names whose route segment is not the name with a capital letter. */
const PAGE_NAMES: Readonly<Record<string, string>> = {
  cpu: "CPU",
  gpu: "GPU",
};

/** The page a dashboard path opens, "Disk" for "/dashboard/disk?from=…"; null when unknown. */
function pageName(path: string): string | null {
  const segment = path.split(/[?#]/, 1)[0]?.split("/")[2] ?? "";
  if (!/^[a-z]+$/.test(segment)) return null;
  return (
    PAGE_NAMES[segment] ?? `${segment[0]?.toUpperCase()}${segment.slice(1)}`
  );
}

/**
 * The back link for a requested `back`: any dashboard path is kept and
 * labelled from its page ("Back to Processes"), anything else returns to Disk.
 */
export function detailBack(requested: string | null): {
  to: string;
  label: string;
} {
  const to = requested?.startsWith("/dashboard/") ? requested : DEFAULT_BACK;
  const page = pageName(to);
  return { to, label: page === null ? "Back" : `Back to ${page}` };
}
