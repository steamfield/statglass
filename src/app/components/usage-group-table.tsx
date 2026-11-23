/**
 * The usage answer on the shared grouped table: the apps Rust ranked, what
 * each app's Quit acts on now, then "Other apps" and "System and other" and
 * the page's footnote.
 */
import type { TimeRange } from "@core/brush";
import type { UsageByApp } from "@core/generated/bindings";
import { remainderRows, usageRows, usageWhole } from "@core/usage-rows";
import { useMemo } from "react";
import { useLocation } from "react-router";
import { FullWidthRow } from "~/components/data-table";
import {
  ProcessGroupTable,
  RemainderRow,
} from "~/components/process-group-table";
import {
  rankedSort,
  remainderCell,
  usageGroupColumns,
} from "~/components/usage-columns";
import { usageGroupRows } from "~/components/usage-group-rows";
import type { UsageTableConfig } from "~/components/usage-table-config";
import { useAppQuitTargets } from "~/hooks/use-running-apps";

/** Apps listed before "Show all": enough to find the culprit, short enough to scan. */
const COLLAPSED_APPS = 10;

export interface UsageGroupTableProps {
  data: UsageByApp;
  config: UsageTableConfig;
  query: string;
  /** Selection and Quit are offered here; null while the edition loads (the table waits). */
  canSignal: boolean | null;
  /** The brushed range the figures cover; null over the chart window. */
  selection: TimeRange | null;
  /** Selection resets when it changes (another brushed range). */
  scopeKey: string;
}

/**
 * The apps in the answer's order (Rust ranks them; the ranked column's
 * header only names it). Only the listed apps' quit targets reach the rows,
 * so a process starting or exiting elsewhere on the Mac rebuilds nothing.
 * The remainder rows sit out a search, since they match nothing.
 */
export function UsageGroupTable({
  data,
  config,
  query,
  canSignal,
  selection,
  scopeKey,
}: UsageGroupTableProps) {
  const { by } = config;
  const ranked = useMemo(() => usageRows(data, by, query), [data, by, query]);
  const names = useMemo(() => ranked.map((r) => r.app.name), [ranked]);
  const appTargets = useAppQuitTargets(names);
  const location = useLocation();
  const rows = useMemo(
    () =>
      usageGroupRows(ranked, appTargets, {
        path: location.pathname,
        search: location.search,
        selection,
      }),
    [ranked, appTargets, location.pathname, location.search, selection]
  );
  const whole = usageWhole(data, by);
  const columns = useMemo(
    () => usageGroupColumns(config, whole),
    [config, whole]
  );
  const sort = useMemo(() => rankedSort(config), [config]);
  const rest = useMemo(() => remainderRows(data, by), [data, by]);
  const searching = query.trim() !== "";
  return (
    <ProcessGroupTable
      rows={rows}
      columns={columns}
      nameHeader="App"
      ariaLabel={`${config.noun} by app`}
      {...(sort === undefined ? {} : { sort })}
      selectable={canSignal}
      scopeKey={scopeKey}
      limit={COLLAPSED_APPS}
      searching={searching}
      empty={
        searching
          ? `No app or process matches “${query.trim()}”.`
          : "No app used a measurable amount in this range."
      }
      after={(table) => (
        <>
          {!searching &&
            rest.map((row, i) => (
              <RemainderRow
                key={row.kind}
                table={table}
                columns={columns}
                name={row.name}
                system={row.kind === "system"}
                first={i === 0}
                cell={remainderCell(config, row)}
              />
            ))}
          <FullWidthRow colSpan={table.colSpan} tone="footnote">
            {config.footnote}
          </FullWidthRow>
        </>
      )}
    />
  );
}
