/**
 * The recorded processes of one open app in a recorded apps table. The
 * loader runs the app's paged query and reports the processes loaded so far
 * to the card, which lists them as the group's members; the status rows
 * render under those members: loading, a read error with Reload, the note on
 * what the instances cover, and Load more. Both read the same query.
 */
import type { TimeRange } from "@core/brush";
import type {
  HistoricalUsageMetric,
  HistoricalUsageProcess,
} from "@core/generated/types";
import { remoteQueryText } from "@core/remote-errors";
import { useEffect, useMemo } from "react";
import { FullWidthRow } from "~/components/data-table";
import { Button } from "~/components/ui/button";
import { TableCell, TableRow } from "~/components/ui/table";
import { useHistoricalProcesses } from "~/hooks/use-historical-usage";

interface AppQuery {
  range: TimeRange;
  by: HistoricalUsageMetric;
  appName: string;
  /** The range is a moving window: the last window's pages hold meanwhile. */
  rolling: boolean;
}

const NONE: readonly HistoricalUsageProcess[] = [];

/**
 * Loads an open app's recorded processes and reports every loaded page's
 * processes, in order, whenever they change: empty while loading or after a
 * restart. Renders nothing.
 */
export function RecordedProcessLoader({
  range,
  by,
  appName,
  rolling,
  onMembers,
}: AppQuery & {
  onMembers: (
    appName: string,
    members: readonly HistoricalUsageProcess[]
  ) => void;
}) {
  const { data } = useHistoricalProcesses(range, by, appName, rolling);
  const members = useMemo(
    () => data?.pages.flatMap((page) => page.processes) ?? NONE,
    [data]
  );
  useEffect(() => onMembers(appName, members), [appName, members, onMembers]);
  return null;
}

/**
 * The rows under an open app's recorded processes. `selectable` widens the
 * indent past the checkbox gutter so the text lines up with member names.
 */
export function RecordedProcessStatus({
  range,
  by,
  appName,
  rolling,
  colSpan,
  selectable,
}: AppQuery & { colSpan: number; selectable: boolean }) {
  const query = useHistoricalProcesses(range, by, appName, rolling);
  const indent = selectable ? "pl-21" : "pl-13";
  if (query.isError)
    return (
      <FullWidthRow colSpan={colSpan} className={indent}>
        <span role="alert">
          {remoteQueryText(query.error, "recorded processes") ??
            "This process listing could not be read."}
        </span>{" "}
        <Button variant="ghost" size="sm" onClick={() => void query.restart()}>
          Reload processes
        </Button>
      </FullWidthRow>
    );
  const pages = query.data?.pages;
  if (!pages)
    return (
      <FullWidthRow colSpan={colSpan} className={indent}>
        Loading recorded processes…
      </FullWidthRow>
    );
  return (
    <>
      <FullWidthRow colSpan={colSpan} tone="footnote" className={indent}>
        {pages.some((page) => page.processes.length > 0)
          ? "Instances that were active in the current interval. Idle ones are not kept, so these need not add up to the app, and RAM peaks need not add to the app peak."
          : "No instance was active enough in the current interval to keep its own detail."}
        {pages[0]?.network_app_level_only &&
          " Network is recorded at app level only."}
      </FullWidthRow>
      {query.hasNextPage && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={colSpan} className={`${indent} py-1`}>
            <Button
              variant="ghost"
              size="sm"
              // Line the label up with the member names, past the button's padding.
              className="-ml-2.5"
              // A held window's cursor does not page the next window.
              disabled={query.isFetchingNextPage || query.isPlaceholderData}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage
                ? "Loading more processes…"
                : "Load more recorded processes"}
            </Button>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
