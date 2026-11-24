/**
 * How a recorded apps table reads as app groups and member processes for
 * `ProcessGroupTable`: apps from the recorded reply, members from the
 * recorded process pages loaded so far, and what each row selects and quits
 * from the processes running now. Plus the metric columns those rows show.
 */
import { recordedProcessStart } from "@core/chart-range";
import type { ByteUnits } from "@core/format";
import type {
  HistoricalUsageApp,
  HistoricalUsageFigures,
  HistoricalUsageMetric,
  HistoricalUsageProcess,
} from "@core/generated/types";
import { HISTORICAL_LABELS } from "@core/historical-usage";
import { targetKey } from "@core/process-selection";
import { HistoricalUsageFigure } from "~/components/historical-usage-cells";
import type { GroupColumn, GroupRows } from "~/components/process-group-table";
import {
  type AppQuitTargets,
  NOT_RUNNING,
  type RunningMatches,
} from "~/hooks/use-running-apps";

/** Recorded processes loaded so far, by app name, across their pages. */
export type RecordedMembers = ReadonlyMap<
  string,
  readonly HistoricalUsageProcess[]
>;

const NONE: readonly HistoricalUsageProcess[] = [];

/** A recorded app's group key: its name, kept apart from member keys. */
export const recordedAppKey = (app: Pick<HistoricalUsageApp, "name">) =>
  `app:${app.name}`;

/** What the rows act on now: the listed apps' quit targets and the loaded processes' live matches. */
export interface RecordedRunning {
  apps: AppQuitTargets | null;
  processes: RunningMatches | null;
}

/**
 * Recorded apps as groups. An app's count is unknown until its processes
 * load, and it expands when the recording kept process detail. An app row
 * quits the running processes of the same app name that Quit acts on; a
 * recorded process selects the live process with its pid and start time.
 * Rows with no running match offer nothing ("Not running"). The running
 * answers are null where this view cannot quit or before the first live
 * batch; rows then offer nothing and give no reason, since none is known yet.
 */
export function recordedGroupRows(
  apps: readonly HistoricalUsageApp[],
  members: RecordedMembers,
  running: RecordedRunning
): GroupRows<HistoricalUsageApp, HistoricalUsageProcess> {
  const match = (p: HistoricalUsageProcess) =>
    running.processes?.get(targetKey(p)) ?? null;
  const known = running.apps !== null && running.processes !== null;
  const reason = () => (known ? NOT_RUNNING : undefined);
  return {
    groups: apps,
    key: recordedAppKey,
    name: (app) => app.name,
    count: () => null,
    expandable: (app) => app.process_details_available,
    members: (app) => members.get(app.name) ?? NONE,
    targets: (app) => running.apps?.get(app.name) ?? [],
    unavailable: reason,
    memberKey: targetKey,
    memberName: (p) => p.name,
    memberPid: (p) => p.pid,
    // A pid alone can name another process later; its start time cannot.
    memberDetail: (p) => `Started ${recordedProcessStart(p.start_time_us)}`,
    memberTargets: (p) => {
      const live = match(p);
      return live === null ? [] : [live];
    },
    memberUnavailable: reason,
    // Only a known running map can say a process has exited.
    memberMuted: (p) => known && match(p) === null,
  };
}

/** What the metric columns render with. */
export interface RecordedColumnsContext {
  units: ByteUnits;
  spanMs: number;
  compare: boolean;
  /** The previous interval's figures by app name, when comparing. */
  previous: ReadonlyMap<string, HistoricalUsageFigures>;
}

/**
 * One column per metric. Rust ranks the rows, so every column is a sort
 * header that re-queries rather than a client sort. Members show their own
 * figures without a comparison.
 */
export function recordedColumns(
  metrics: readonly HistoricalUsageMetric[],
  ctx: RecordedColumnsContext
): GroupColumn<HistoricalUsageApp, HistoricalUsageProcess>[] {
  return metrics.map((metric) => ({
    id: metric,
    header: HISTORICAL_LABELS[metric],
    align: "right",
    sortable: true,
    className: "figures",
    group: (app) => (
      <HistoricalUsageFigure
        figures={app.figures}
        metric={metric}
        units={ctx.units}
        spanMs={ctx.spanMs}
        previous={ctx.previous.get(app.name)}
        compare={ctx.compare}
      />
    ),
    member: (p) => (
      <HistoricalUsageFigure
        figures={p.figures}
        metric={metric}
        units={ctx.units}
        spanMs={ctx.spanMs}
      />
    ),
  }));
}
