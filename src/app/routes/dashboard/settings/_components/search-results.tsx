/**
 * The Settings body while a search query is set: a status line with how many
 * settings match, then each matched tab's real panels under a header that
 * links to the tab. A generated stylesheet (`searchStyles`) hides what did
 * not match, so every result is the working control. With nothing to show,
 * it says so and offers a few queries to try.
 */
import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Button } from "~/components/ui/button";
import {
  SETTINGS_TABS,
  type SettingsTabId,
  settingsHref,
} from "~/lib/settings-links";
import {
  GROUP_ATTR,
  matchedRowCount,
  matchSettings,
  RESULTS_ATTR,
  type SettingsMatch,
  searchStyles,
} from "../_lib/search";
import { TabContent } from "./tab-content";

/** Queries offered when nothing matches. */
const SUGGESTIONS = ["appearance", "interval", "history", "iphone"] as const;

/** An inline link to another dashboard page, as SettingsLink draws one. */
const PAGE_LINK =
  "rounded-chip text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring";

/** Row ids that rendered, or null before any section has rendered at all. */
type RenderedRows = ReadonlySet<string> | null;

/** The `data-settings-row` ids under `root` now, or null with no sections yet. */
function readRenderedRows(root: HTMLElement): RenderedRows {
  if (!root.querySelector("[data-settings-section]")) return null;
  const rows = root.querySelectorAll("[data-settings-row]");
  return new Set(
    [...rows].map((row) => row.getAttribute("data-settings-row") ?? "")
  );
}

function sameRows(a: RenderedRows, b: RenderedRows): boolean {
  if (a === null || b === null) return a === b;
  return a.size === b.size && [...a].every((id) => b.has(id));
}

/**
 * The rows rendered under the ref'd element, kept current as panels mount
 * after their settings or queries load. Panels render rows conditionally
 * (Network history needs per-app network), so the catalog alone can't say
 * which matches exist.
 */
function useRenderedRows(rootRef: RefObject<HTMLElement | null>): RenderedRows {
  const [rendered, setRendered] = useState<RenderedRows>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const read = () => {
      const next = readRenderedRows(root);
      setRendered((prev) => (sameRows(prev, next) ? prev : next));
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [rootRef]);
  return rendered;
}

/**
 * The first matched row that shows under the results `root`, with its tab:
 * where Return and "Open in" lead. Before any panel renders it is the
 * catalog's first match; null when nothing shows.
 */
export function firstShownMatch(
  query: string,
  root: HTMLElement | null
): { tab: SettingsTabId; row: string } | null {
  const rendered = root ? readRenderedRows(root) : null;
  for (const match of matchSettings(query)) {
    const row = match.rowIds.find((id) => rendered?.has(id) ?? true);
    if (row) return { tab: match.tab, row };
  }
  return null;
}

/** How many matched rows show: the catalog count until any panel renders. */
function shownCount(matches: readonly SettingsMatch[], rendered: RenderedRows) {
  if (rendered === null) return matchedRowCount(matches);
  return matches
    .flatMap((match) => match.rowIds)
    .filter((id) => rendered.has(id)).length;
}

/** "1 setting matches “q”", "3 settings match “q”" or "No settings match “q”." */
function statusText(count: number, query: string): string {
  if (count === 0) return `No settings match “${query}”.`;
  if (count === 1) return `1 setting matches “${query}”`;
  return `${count} settings match “${query}”`;
}

/** How someone leaves the current results. */
interface ResultsNavigation {
  /** Searches for a suggested query instead, focus back in the field. */
  onSuggest: (query: string) => void;
  /** Leaves search for the tab an "Open in" link is going to. */
  onOpen: () => void;
}

/** What to try when nothing matches, and where other settings live. */
function NoResults({ onSuggest }: Pick<ResultsNavigation, "onSuggest">) {
  return (
    <div className="flex flex-col gap-3 font-normal text-muted-foreground text-small">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1">Try</span>
        {SUGGESTIONS.map((suggestion) => (
          <Button
            key={suggestion}
            variant="outline"
            size="sm"
            onClick={() => onSuggest(suggestion)}
          >
            {suggestion}
          </Button>
        ))}
      </div>
      <p>
        Alert rules and destinations are on the{" "}
        <Link to="/dashboard/alerts" className={PAGE_LINK}>
          Alerts
        </Link>{" "}
        page. Per-host options are on{" "}
        <Link to="/dashboard/hosts" className={PAGE_LINK}>
          Hosts
        </Link>
        .
      </p>
    </div>
  );
}

/** One matched tab: its name, a link into it, then its panels. */
function ResultGroup({
  match,
  rendered,
  onOpen,
}: Pick<ResultsNavigation, "onOpen"> & {
  match: SettingsMatch;
  rendered: RenderedRows;
}) {
  const label = SETTINGS_TABS.find((tab) => tab.id === match.tab)?.label;
  const firstRow =
    match.rowIds.find((id) => rendered?.has(id)) ?? match.rowIds[0];
  return (
    <div {...{ [GROUP_ATTR]: match.tab }} className="flex flex-col gap-2.5">
      <div className="flex items-center gap-1.5 font-medium text-muted-foreground text-small">
        {label}
        <Button
          asChild
          variant="link"
          size="sm"
          className="ml-auto h-auto px-0"
        >
          <Link to={settingsHref(match.tab, firstRow)} onClick={onOpen}>
            Open in {label}
          </Link>
        </Button>
      </div>
      <div className="flex flex-col gap-5">
        <TabContent tab={match.tab} />
      </div>
    </div>
  );
}

/**
 * The search results for `query`, replacing the active tab's panels. Only
 * rows that rendered are counted, so a matched row a panel leaves out
 * (Network history without per-app network) neither shows nor counts.
 */
export function SearchResults({
  query,
  onSuggest,
  onOpen,
}: ResultsNavigation & { query: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const rendered = useRenderedRows(rootRef);
  const matches = matchSettings(query);
  const count = shownCount(matches, rendered);

  return (
    <div
      ref={rootRef}
      {...{ [RESULTS_ATTR]: "" }}
      className="flex flex-col gap-5"
    >
      <p role="status" className="font-normal text-muted-foreground text-small">
        {statusText(count, query.trim())}
      </p>
      {count === 0 && <NoResults onSuggest={onSuggest} />}
      <style>{searchStyles(matches)}</style>
      {matches.map((match) => (
        <ResultGroup
          key={match.tab}
          match={match}
          rendered={rendered}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}
