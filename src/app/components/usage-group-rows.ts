/**
 * How the usage answer reads as app groups and member processes for
 * `ProcessGroupTable`, and where a member's detail link goes.
 */
import type { TimeRange } from "@core/brush";
import type { ProcessUsage } from "@core/generated/bindings";
import { targetKey } from "@core/process-selection";
import { writeRange } from "@core/range-params";
import type { UsageRow } from "@core/usage-rows";
import type { GroupRows } from "~/components/process-group-table";
import type { AppQuitTargets } from "~/hooks/use-running-apps";

/** Why an app or process row offers no Quit. */
const NOT_RUNNING = "Not running";
const EXITED = "exited";

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

/**
 * The usage answer as app groups. An app row quits what Quit on that app
 * acts on in the live batch (`appTargets`), so every table quits an app the
 * same way. Members are the processes the answer lists (the search matches
 * while searching); running ones act on themselves, exited ones offer
 * nothing. Running members link to their detail page; exited ones too over
 * a brushed range, which the page can show them over. Before the first live
 * batch no row says why it offers nothing, since nothing is known yet.
 */
export function usageGroupRows(
  ranked: readonly UsageRow[],
  appTargets: AppQuitTargets | null,
  scope: DetailScope
): GroupRows<UsageRow, ProcessUsage> {
  const targets = (r: UsageRow) => appTargets?.get(r.app.name) ?? [];
  return {
    groups: ranked,
    key: (r) => `app:${r.app.name}`,
    name: (r) => r.app.name,
    count: (r) => r.app.processes.length,
    members: (r) => r.processes,
    forcedOpen: (r) => r.matchedInside,
    targets,
    unavailable: (r) =>
      appTargets !== null && targets(r).length === 0 ? NOT_RUNNING : undefined,
    memberKey: targetKey,
    memberName: (p) => p.name,
    memberPid: (p) => p.pid,
    memberHref: (p) =>
      p.running || scope.selection !== null ? detailHref(p, scope) : undefined,
    memberTargets: (p) => (p.running ? [p] : []),
    memberUnavailable: (p) => (p.running ? undefined : EXITED),
    memberMuted: (p) => !p.running,
  };
}
