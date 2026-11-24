/**
 * How the usage answer reads as app groups and member processes for
 * `ProcessGroupTable`, and where a member's detail link goes.
 */
import type { TimeRange } from "@core/brush";
import type { ProcessUsage } from "@core/generated/types";
import { targetKey } from "@core/process-selection";
import { writeRange } from "@core/range-params";
import type { UsageRow } from "@core/usage-rows";
import type { GroupRows } from "~/components/process-group-table";
import {
  type AppQuitTargets,
  NOT_RUNNING,
  type RunningMatches,
} from "~/hooks/use-running-apps";

/** Where a member's detail link comes back to, and the range it shows. */
export interface DetailScope {
  path: string;
  search: string;
  selection: TimeRange | null;
}

/**
 * A process's detail page link. The brushed range rides along twice: the
 * detail page shows the process over it, and its back link returns to it,
 * even before this page's URL mirror has caught up with the brush.
 */
function detailHref(p: ProcessUsage, scope: DetailScope): string {
  const backParams = new URLSearchParams(scope.search);
  writeRange(backParams, scope.selection);
  const backSearch = backParams.toString();
  const params = new URLSearchParams({
    back: `${scope.path}${backSearch ? `?${backSearch}` : ""}`,
  });
  writeRange(params, scope.selection);
  return `/dashboard/processes/${p.pid}/${p.start_time_us}?${params}`;
}

/** What the rows act on now: the listed apps' quit targets and the listed processes' live matches. */
export interface UsageRunning {
  apps: AppQuitTargets | null;
  processes: RunningMatches | null;
}

/**
 * The usage answer as app groups. An app row quits what Quit on that app
 * acts on in the live batch, so every table quits an app the same way.
 * Members are the processes the answer lists (the search matches while
 * searching); one in the live batch acts on its live process, with that
 * process's refusal, and one that is not offers nothing ("Not running").
 * `ProcessUsage.running` is frozen with a closed range, so it only stands in
 * where no live batch is known (before the first, or where this view cannot
 * quit), and only for the link and the dimming. Running members link to
 * their detail page; exited ones too over a brushed range, which the page
 * can show them over. Before the first live batch no row says why it
 * offers nothing, since nothing is known yet.
 */
export function usageGroupRows(
  ranked: readonly UsageRow[],
  running: UsageRunning,
  scope: DetailScope
): GroupRows<UsageRow, ProcessUsage> {
  const targets = (r: UsageRow) => running.apps?.get(r.app.name) ?? [];
  const match = (p: ProcessUsage) =>
    running.processes?.get(targetKey(p)) ?? null;
  const isRunning = (p: ProcessUsage) =>
    running.processes === null ? p.running : match(p) !== null;
  const known = running.apps !== null && running.processes !== null;
  return {
    groups: ranked,
    key: (r) => `app:${r.app.name}`,
    name: (r) => r.app.name,
    count: (r) => r.app.processes.length,
    members: (r) => r.processes,
    forcedOpen: (r) => r.matchedInside,
    targets,
    unavailable: () => (known ? NOT_RUNNING : undefined),
    memberKey: targetKey,
    memberName: (p) => p.name,
    memberPid: (p) => p.pid,
    memberHref: (p) =>
      isRunning(p) || scope.selection !== null
        ? detailHref(p, scope)
        : undefined,
    memberTargets: (p) => {
      const live = match(p);
      return live === null ? [] : [live];
    },
    memberUnavailable: () => (known ? NOT_RUNNING : undefined),
    memberMuted: (p) => !isRunning(p),
  };
}
