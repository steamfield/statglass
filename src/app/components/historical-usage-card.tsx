/**
 * The recorded apps card for a fixed range: the range and coverage notes,
 * the previous-interval comparison, and the recorded apps table, whose rows
 * select and quit what is running now under the same app name or identity.
 */
import type { TimeRange } from "@core/brush";
import { recordedDate } from "@core/chart-range";
import { formatSpan } from "@core/format";
import type {
  HistoricalUsageApp,
  HistoricalUsageMetric,
  HistoricalUsageProcess,
  HistoricalUsageReply,
} from "@core/generated/bindings";
import { USAGE_HISTORY_MAX_RANGE_MS } from "@core/generated/bindings";
import {
  HISTORICAL_COLUMNS,
  HISTORICAL_LABELS,
  historicalCoverage,
} from "@core/historical-usage";
import { historyKeys } from "@core/query-keys";
import { remoteQueryText } from "@core/remote-errors";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppsNote, AppsShell, UnrecordedRange } from "~/components/app-table";
import { type ColumnSort, FullWidthRow } from "~/components/data-table";
import {
  RecordedProcessLoader,
  RecordedProcessStatus,
} from "~/components/historical-usage-processes";
import {
  type RecordedMembers,
  recordedAppKey,
  recordedColumns,
  recordedGroupRows,
} from "~/components/historical-usage-rows";
import { ProcessGroupTable } from "~/components/process-group-table";
import { Button } from "~/components/ui/button";
import { useCanSignalSettled } from "~/hooks/use-edition";
import { useHistoricalUsage } from "~/hooks/use-historical-usage";
import { useRunningApps } from "~/hooks/use-running-apps";
import { useUnits } from "~/hooks/use-units";
import { useHostId } from "~/stores/host-store";
import type { Accent } from "~/widgets/lib/accent";

/** The recorded ranking: a metric and its direction. */
export type HistoricalUsageSort = ColumnSort<HistoricalUsageMetric>;

/**
 * Recorded app usage over `range`, ranked by Rust by the sorted metric.
 * Controlled when `sort` is given; `compare` adds the preceding equal interval.
 */
export function HistoricalUsageCard({
  range,
  by,
  accent = "cpu",
  columns = HISTORICAL_COLUMNS,
  title = "Apps in this range",
  compare = false,
  sort: controlledSort,
  onSortChange,
}: {
  range: TimeRange | null;
  by: HistoricalUsageMetric;
  accent?: Accent;
  columns?: readonly HistoricalUsageMetric[];
  title?: string;
  compare?: boolean;
  sort?: HistoricalUsageSort;
  onSortChange?: (sort: HistoricalUsageSort) => void;
}) {
  const [localSort, setLocalSort] = useState<HistoricalUsageSort>({
    by,
    dir: "desc",
  });
  useEffect(() => setLocalSort({ by, dir: "desc" }), [by]);
  const selected = controlledSort ?? localSort;
  const sort = visibleSort(selected, by, columns);
  const query = useHistoricalUsage(range, sort.by);
  const names = useMemo(
    () => query.data?.apps.map((app) => app.name) ?? [],
    [query.data]
  );
  const previousRange = comparisonRange(range, compare, names.length);
  const previous = useHistoricalUsage(previousRange, sort.by, {
    appNames: names,
  });
  const host = useHostId();
  const client = useQueryClient();
  const change = (next: HistoricalUsageSort) => {
    setLocalSort(next);
    onSortChange?.(next);
  };
  if (range && range.toMs - range.fromMs > USAGE_HISTORY_MAX_RANGE_MS)
    return (
      <AppsShell title={title} accent={accent}>
        <AppsNote>
          Recorded app attribution supports intervals up to 30 days. Choose a
          shorter range to inspect apps.
        </AppsNote>
      </AppsShell>
    );
  return (
    <AppsShell
      title={title}
      accent={accent}
      aside={
        <Button
          variant="ghost"
          size="sm"
          disabled={query.isFetching || range === null}
          onClick={() => {
            if (range)
              void client.resetQueries({
                queryKey: historyKeys.usageProcessRange(
                  host,
                  range.fromMs,
                  range.toMs
                ),
              });
            void query.refetch();
            if (compare) void previous.refetch();
          }}
        >
          Refresh
        </Button>
      }
    >
      {range && (
        <AppsNote>
          <span className="figures">
            {recordedDate(range.fromMs)} to {recordedDate(range.toMs)}
          </span>{" "}
          · {Intl.DateTimeFormat().resolvedOptions().timeZone}
        </AppsNote>
      )}
      {query.isError ? (
        <AppsNote>
          <span role="alert">
            {remoteQueryText(query.error, "recorded app usage") ??
              "Recorded app usage could not be read."}
          </span>{" "}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void query.refetch()}
          >
            Retry
          </Button>
        </AppsNote>
      ) : !query.data || !range ? (
        <AppsNote>
          <span role="status">Loading recorded apps…</span>
        </AppsNote>
      ) : (
        <>
          {query.isFetching && (
            <AppsNote>
              <span role="status">Refreshing recorded apps…</span>
            </AppsNote>
          )}
          <HistoricalCoverage data={query.data} by={sort.by} />
          {compare && previousRange && (
            <AppsNote>
              <span className="figures">
                Previous: {recordedDate(previousRange.fromMs)} to{" "}
                {recordedDate(previousRange.toMs)}
              </span>
              {previous.isFetching && " · Loading previous interval…"}
              {previous.isError && (
                <>
                  <span role="alert"> · Previous interval unavailable.</span>{" "}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void previous.refetch()}
                  >
                    Retry previous interval
                  </Button>
                </>
              )}
            </AppsNote>
          )}
          {compare && previous.data && (
            <HistoricalCoverage data={previous.data} by={sort.by} previous />
          )}
          <HistoricalUsageTable
            key={`${host}:${range.fromMs}:${range.toMs}:${sort.by}`}
            data={query.data}
            previous={previous.data}
            range={range}
            columns={columns}
            sort={sort}
            onSort={change}
            compare={compare}
          />
        </>
      )}
    </AppsShell>
  );
}

function HistoricalCoverage({
  data,
  by,
  previous = false,
}: {
  data: HistoricalUsageReply;
  by: HistoricalUsageMetric;
  previous?: boolean;
}) {
  const coverage = data.range.coverage.find((c) => c.metric === by)?.coverage;
  const resolutions = [
    ...new Set(data.range.spans.map((span) => span.resolution_ms)),
  ]
    .map(formatSpan)
    .join(", ");
  const incomplete = coverage?.causes
    .map((cause) => COVERAGE_CAUSES[cause])
    .filter((cause, index, all) => all.indexOf(cause) === index)
    .join("; ");
  return (
    <AppsNote>
      {previous ? "Previous " : ""}
      {HISTORICAL_LABELS[by]}:{" "}
      {historicalCoverage(
        coverage,
        data.range.requested_to_ms - data.range.requested_from_ms
      )}
      .{resolutions && ` Resolution: ${resolutions}.`}
      {!data.ranking_complete &&
        ` Observed ranking${incomplete ? `: ${incomplete}` : "; some use could not be recorded"}.`}
      {data.network_uncertainty.length > 0 &&
        " Some network bytes have uncertain transfer times and are excluded from exact totals."}
    </AppsNote>
  );
}

const COVERAGE_CAUSES = {
  not_recorded: "attribution was not recorded",
  pruned: "older history was removed",
  sampling_gap: "recording has gaps",
  read_failed: "a source read failed",
  no_baseline: "some first observations lacked a rate baseline",
  unreadable_process: "some processes could not be read",
  unresolved_identity: "some app identities were unknown",
  identity_limit: "some app identities could not be retained",
  uncertain_network_time: "some network transfer times are uncertain",
  partial_boundary: "partial edge buckets were excluded",
  resource_limit: "a recording limit was reached",
} as const;

function HistoricalUsageTable({
  data,
  previous,
  range,
  columns,
  sort,
  onSort,
  compare,
}: {
  data: HistoricalUsageReply;
  previous: HistoricalUsageReply | undefined;
  range: TimeRange;
  columns: readonly HistoricalUsageMetric[];
  sort: HistoricalUsageSort;
  onSort: (sort: HistoricalUsageSort) => void;
  compare: boolean;
}) {
  const host = useHostId();
  const units = useUnits();
  const running = useRunningApps();
  // Null until known: the shared table renders nothing rather than gain its
  // checkbox column a moment later.
  const selectable = useCanSignalSettled();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const members = useRecordedMembers();
  const spanMs = range.toMs - range.fromMs;
  const apps = useMemo(
    () => (sort.dir === "asc" ? [...data.apps].reverse() : data.apps),
    [data.apps, sort.dir]
  );
  // Memoised on the reply, the loaded pages and the running map, which keeps
  // its identity while no process starts or exits: no re-render each second.
  const rows = useMemo(
    () => recordedGroupRows(apps, members.loaded, running),
    [apps, members.loaded, running]
  );
  const groupColumns = useMemo(
    () =>
      recordedColumns(columns, {
        units: units.bytes,
        spanMs,
        compare,
        previous: new Map(previous?.apps.map((app) => [app.name, app.figures])),
      }),
    [columns, units.bytes, spanMs, compare, previous]
  );
  const tableSort = useMemo(
    () => ({
      value: sort,
      onChange: (next: ColumnSort<string>) => {
        const by = columns.find((metric) => metric === next.by);
        if (by) onSort({ by, dir: next.dir });
      },
      client: false,
      nameSortable: false,
    }),
    [sort, onSort, columns]
  );
  const expansion = useMemo(() => ({ open, onChange: setOpen }), [open]);
  const afterMembers = useCallback(
    (app: HistoricalUsageApp, colSpan: number) => (
      <RecordedProcessStatus
        range={range}
        by={sort.by}
        appName={app.name}
        colSpan={colSpan}
        selectable={selectable === true}
      />
    ),
    [range, sort.by, selectable]
  );
  if (apps.length === 0)
    return (
      <UnrecordedRange>
        Attribution was not recorded for this interval.
      </UnrecordedRange>
    );
  return (
    <>
      {apps
        .filter((app) => open.has(recordedAppKey(app)))
        .map((app) => (
          <RecordedProcessLoader
            key={app.name}
            range={range}
            by={sort.by}
            appName={app.name}
            onMembers={members.report}
          />
        ))}
      <ProcessGroupTable
        rows={rows}
        columns={groupColumns}
        nameHeader="App"
        ariaLabel="Recorded apps in this range"
        sort={tableSort}
        expansion={expansion}
        selectable={selectable}
        scopeKey={`${host}:${range.fromMs}:${range.toMs}`}
        afterMembers={afterMembers}
        after={(colSpan) => (
          <FullWidthRow colSpan={colSpan} tone="footnote">
            Up to ten recorded apps for{" "}
            {HISTORICAL_LABELS[sort.by].toLowerCase()}; reversing the order
            keeps those same apps. CPU power estimates CPU energy only.
          </FullWidthRow>
        )}
        empty={null}
      />
    </>
  );
}

/**
 * The recorded processes each open app's loader has reported, by app name.
 * `report` keeps the map when nothing changed, so a loader's effect costs no
 * render.
 */
function useRecordedMembers() {
  const [loaded, setLoaded] = useState<RecordedMembers>(() => new Map());
  const report = useCallback(
    (app: string, list: readonly HistoricalUsageProcess[]) =>
      setLoaded((current) =>
        current.get(app) === list ? current : new Map(current).set(app, list)
      ),
    []
  );
  return { loaded, report };
}

function visibleSort(
  sort: HistoricalUsageSort,
  by: HistoricalUsageMetric,
  columns: readonly HistoricalUsageMetric[]
): HistoricalUsageSort {
  if (columns.includes(sort.by)) return sort;
  return { by: columns.includes(by) ? by : (columns[0] ?? by), dir: "desc" };
}

function comparisonRange(
  range: TimeRange | null,
  compare: boolean,
  count: number
): TimeRange | null {
  if (
    !range ||
    !compare ||
    count === 0 ||
    range.fromMs < range.toMs - range.fromMs
  )
    return null;
  return {
    fromMs: range.fromMs - (range.toMs - range.fromMs),
    toMs: range.fromMs,
  };
}
