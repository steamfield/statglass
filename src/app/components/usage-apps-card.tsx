/**
 * The per-app usage card of the CPU, GPU, Memory, Power and Disk pages:
 * apps over the chart window or the brushed range, rendered by the shared
 * grouped table, with coverage notes above and the remainder rows and
 * footnote below.
 */
import { scopeWords, type TimeRange } from "@core/brush";
import { percentOf } from "@core/chart-math";
import { formatClockSeconds, formatPercent, formatSpan } from "@core/format";
import type {
  ProcessUsage,
  UsageByApp,
  UsageKey,
} from "@core/generated/bindings";
import { appQuitTargets, type RunningApps } from "@core/process-groups";
import { type ProcessTarget, targetKey } from "@core/process-selection";
import { writeRange } from "@core/range-params";
import { remoteQueryText } from "@core/remote-errors";
import {
  gpuShortfall,
  type RemainderRow,
  remainderRows,
  type UsageFigures,
  type UsageRow,
  usageCoverage,
  usageRows,
  usageValue,
  usageWhole,
} from "@core/usage-rows";
import { memo, type ReactNode, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import {
  AppsNote,
  AppsShell,
  OtherAppsRow,
  ShareCell,
  UnrecordedRange,
} from "~/components/app-table";
import { brushScopeProps } from "~/components/brush-overlay";
import { FullWidthRow, MeterCell } from "~/components/data-table";
import { HistoricalUsageCard } from "~/components/historical-usage-card";
import {
  type ClientSort,
  type GroupColumn,
  type GroupRows,
  ProcessGroupTable,
} from "~/components/process-group-table";
import { SearchField } from "~/components/search-field";
import { SelectionChip } from "~/components/selection-chip";
import { TableCell } from "~/components/ui/table";
import { useCanSignalSettled } from "~/hooks/use-edition";
import { useHostNoun } from "~/hooks/use-host-record";
import { useModuleEnd, useUsageHistorical } from "~/hooks/use-module-end";
import { heldFor, useRangeScope } from "~/hooks/use-range-scope";
import { useRunningApps } from "~/hooks/use-running-apps";
import { useUsageByApp } from "~/hooks/use-usage-by-app";
import { cn } from "~/lib/utils";
import type { Accent } from "~/widgets/lib/accent";

/** Apps listed before "Show all": enough to find the culprit, short enough to scan. */
const COLLAPSED_APPS = 10;

/** A remainder row's cells, sized like the grouped table's rows above them. */
const REST_CELL = "h-[29px] whitespace-nowrap px-3 py-0 font-normal text-small";

/** Why an app or process row offers no Quit. */
const NOT_RUNNING = "Not running";
const EXITED = "exited";

/** What a cell can read: any row's figures, and an app's average footprint. */
export type UsageCells = UsageFigures & { mem_avg_bytes?: number };

export interface UsageColumn {
  /** Column head ("Avg CPU"). */
  label: string;
  format: (u: UsageCells) => string;
  /** The table is ranked by this column (Rust sorts by the page's key). */
  ranked?: boolean;
}

export interface UsageTableConfig {
  by: UsageKey;
  /** "CPU": the title reads "CPU by app, last 15 minutes". */
  noun: string;
  accent: Accent;
  columns: readonly UsageColumn[];
  /** Under the rows: what the figures are and what they leave out. */
  footnote: ReactNode;
}

interface UsageAppsCardProps {
  windowMs: number;
  config: UsageTableConfig;
}

/**
 * Fixed and long ranges use read-only source history. Live short ranges keep
 * per-app use over the chart window (D-091), or over the brushed range
 * when there is one (D-099): which apps used the resource, not what is busy
 * now (that is the Processes page). Rows are apps that sum their processes
 * and expand to list them; an app's actions target what Quit on that app
 * acts on in the live process batch, with individual processes selectable
 * too. After the apps come "Other apps" and "System and other", so additive
 * columns add up to the host's figure.
 */
export function UsageAppsCard(props: UsageAppsCardProps) {
  const historical = useUsageHistorical(props.windowMs);
  return historical ? (
    <MemoHistoricalUsageApps {...props} />
  ) : (
    <LiveUsageAppsCard {...props} />
  );
}

function HistoricalUsageApps({ windowMs, config }: UsageAppsCardProps) {
  const { range } = useRangeScope(windowMs);
  if (config.by === "disk") {
    return (
      <AppsShell accent="disk" title="Disk by app">
        <UnrecordedRange>Per-app disk history isn’t recorded</UnrecordedRange>
      </AppsShell>
    );
  }
  return (
    <HistoricalUsageCard
      range={range}
      by={config.by}
      accent={config.accent}
      title={`${config.noun} by app`}
    />
  );
}

const MemoHistoricalUsageApps = memo(HistoricalUsageApps);

function LiveUsageAppsCard({ windowMs, config }: UsageAppsCardProps) {
  const fixedEnd = useModuleEnd();
  const { selection, range, keepPrevious } = useRangeScope(windowMs);
  const q = useUsageByApp(range, config.by, { keepPrevious });
  const [query, setQuery] = useState("");
  // The App Store edition has no Quit or Force Quit (D-065), and a remote
  // host's processes are never signalled from here (D-117). Both are asked
  // for at mount; the table waits for the edition so its columns hold still.
  const canSignal = useCanSignalSettled();
  const running = useRunningApps();
  const data = heldFor(q, windowMs);
  const shown: TimeRange | null = data
    ? { fromMs: data.from_ms, toMs: data.to_ms }
    : selection;

  let body: ReactNode;
  if (q.isError) {
    body = (
      <AppsNote>
        {remoteQueryText(q.error, "use by app") ?? "Couldn't load use by app."}
      </AppsNote>
    );
  } else if (!data) {
    body = <AppsNote>Loading use by app…</AppsNote>;
  } else {
    body = (
      <MemoUsageBody
        data={data}
        config={config}
        query={query}
        canSignal={canSignal}
        running={running}
        selection={selection}
        scopeKey={
          selection
            ? `${selection.fromMs}:${selection.toMs}`
            : `live:${windowMs}`
        }
      />
    );
  }

  return (
    <div {...brushScopeProps} className="contents">
      <AppsShell
        accent={config.accent}
        title={`${config.noun} by app, ${scopeWords(selection ? (shown ?? selection) : fixedEnd === null ? null : range, windowMs)}`}
        aside={
          <>
            <SearchField
              value={query}
              onChange={setQuery}
              placeholder="App, process or PID"
              label={`Search ${config.noun} by app, process or PID`}
            />
            {selection && shown && <SelectionChip range={shown} />}
          </>
        }
      >
        {body}
      </AppsShell>
    </div>
  );
}

interface UsageTableProps {
  data: UsageByApp;
  config: UsageTableConfig;
  query: string;
  /** Selection and Quit are offered here; null while the edition loads (the table waits). */
  canSignal: boolean | null;
  /** The live batch by app; null where Quit is not offered or before it arrives. */
  running: RunningApps | null;
  /** The brushed range the figures cover; null over the chart window. */
  selection: TimeRange | null;
  /** Selection resets when it changes (another brushed range). */
  scopeKey: string;
}

/** The notes over the table, or what stands in for it when nothing was measured. */
function UsageBody({
  data,
  config,
  query,
  canSignal,
  running,
  selection,
  scopeKey,
}: UsageTableProps) {
  const coverage = usageCoverage(data);
  const noun = useHostNoun();
  if (coverage.kind === "waiting") {
    return <AppsNote>Waiting for the first process sample…</AppsNote>;
  }
  if (coverage.kind === "unrecorded") {
    return <Unrecorded sinceMs={coverage.sinceMs} />;
  }
  return (
    <>
      {coverage.kind === "partial" && (
        <AppsNote>
          StatGlass started counting at{" "}
          <span className="figures">
            {formatClockSeconds(coverage.sinceMs)}
          </span>
          , so these figures cover{" "}
          <span className="figures">{formatSpan(coverage.coveredMs)}</span>.
        </AppsNote>
      )}
      {coverage.kind === "gaps" && (
        <AppsNote>
          Processes were sampled for{" "}
          <span className="figures">{formatSpan(coverage.coveredMs)}</span> of{" "}
          <span className="figures">{formatSpan(coverage.spanMs)}</span> (the{" "}
          {noun} slept or sampling paused). Averages are over the sampled time.
        </AppsNote>
      )}
      {config.by === "gpu" && <GpuShortfallNote data={data} />}
      {data.other.clamped.includes(config.by) && (
        <AppsNote>
          Apps measured above the system total somewhere in this range (the two
          are sampled differently), so System and other reads low there.
        </AppsNote>
      )}
      <UsageTable
        data={data}
        config={config}
        query={query}
        canSignal={canSignal}
        running={running}
        selection={selection}
        scopeKey={scopeKey}
      />
    </>
  );
}

const MemoUsageBody = memo(UsageBody);

/**
 * The answer's rows and what each app's Quit acts on now. Only the listed
 * apps' targets reach the table, so a process starting or exiting elsewhere
 * on the Mac does not rebuild it.
 */
function UsageTable({
  data,
  config,
  query,
  running,
  ...rest
}: UsageTableProps) {
  const { by } = config;
  const ranked = useMemo(() => usageRows(data, by, query), [data, by, query]);
  const appTargets = useListedAppTargets(ranked, running);
  return (
    <MemoUsageGroupTable
      data={data}
      config={config}
      query={query}
      ranked={ranked}
      appTargets={appTargets}
      {...rest}
    />
  );
}

/** Each listed app's quit targets by name; null before the first live batch. */
type AppTargets = ReadonlyMap<string, readonly ProcessTarget[]>;

/** What the targets depend on: each listed app's targets, by identity. */
function appTargetsKey(targets: AppTargets): string {
  return [...targets]
    .map(([app, list]) => `${app}\u0000${list.map(targetKey).join(",")}`)
    .join("\u0001");
}

/**
 * The listed apps' quit targets, keeping one map while they hold: the
 * running map changes whenever any process starts or exits, these only when
 * a listed app's targets do.
 */
function useListedAppTargets(
  ranked: readonly UsageRow[],
  running: RunningApps | null
): AppTargets | null {
  const held = useRef<{ key: string; targets: AppTargets } | null>(null);
  if (running === null) {
    held.current = null;
    return null;
  }
  const targets: AppTargets = new Map(
    ranked.map((r) => [r.app.name, appQuitTargets(running, r.app.name)])
  );
  const key = appTargetsKey(targets);
  // Written during render, like the table's held order: the same answer and
  // targets give the same map on every frame.
  if (held.current?.key !== key) held.current = { key, targets };
  return held.current.targets;
}

/**
 * The apps on the shared grouped table. Rust ranks them, so the order is
 * the answer's and the ranked column's header only names it. An app row
 * quits what Quit on that app acts on in the live batch, so every table
 * quits an app the same way; an app with nothing running offers nothing.
 */
function UsageGroupTable({
  data,
  config,
  query,
  ranked,
  appTargets,
  canSignal,
  selection,
  scopeKey,
}: Omit<UsageTableProps, "running"> & {
  ranked: readonly UsageRow[];
  appTargets: AppTargets | null;
}) {
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
  const { by } = config;
  const whole = usageWhole(data, by);
  const columns = useMemo(
    () => usageGroupColumns(config, whole),
    [config, whole]
  );
  const sort = useMemo(() => rankedSort(config), [config]);
  const rest = useMemo(() => remainderRows(data, by), [data, by]);
  const searching = query.trim() !== "";
  return (
    // `relative` holds the header's absolutely placed sr-only labels inside
    // this scroller, or they widen the page on a narrow window.
    <div className="relative overflow-x-auto">
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
        after={(colSpan) => (
          <>
            {!searching && (
              <RestRows
                rows={rest}
                config={config}
                share={whole !== null}
                actions={canSignal === true}
              />
            )}
            <FullWidthRow colSpan={colSpan} tone="footnote">
              {config.footnote}
            </FullWidthRow>
          </>
        )}
      />
    </div>
  );
}

const MemoUsageGroupTable = memo(UsageGroupTable);

/** Where a member's detail link comes back to, and the range it shows. */
interface DetailScope {
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
 * How the usage answer reads as app groups. Members are the processes the
 * answer lists (the search matches while searching); running ones act on
 * themselves, exited ones offer nothing. Running members link to their
 * detail page; exited ones too over a brushed range, which the page can
 * show them over. Before the first live batch no row says why it offers
 * nothing, since nothing is known yet.
 */
function usageGroupRows(
  ranked: readonly UsageRow[],
  appTargets: AppTargets | null,
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

/** Right-aligned figure in a usage cell; the ranked one is brighter on app rows. */
function Figure({ strong, children }: { strong: boolean; children: string }) {
  return (
    <span className={cn("figures", strong && "text-foreground")}>
      {children}
    </span>
  );
}

/**
 * The ranked column, high to low, as the table's order: its header shows
 * the direction. No header sorts, since Rust ranks the rows by the page's
 * key; undefined when no column is ranked.
 */
function rankedSort(config: UsageTableConfig): ClientSort | undefined {
  const ranked = config.columns.find((c) => c.ranked);
  if (ranked === undefined) return undefined;
  return {
    value: { by: ranked.label, dir: "desc" },
    onChange: unsortable,
    client: false,
    nameSortable: false,
  };
}

/** `ClientSort.onChange` for a table with no sortable header: never called. */
function unsortable(): void {
  return;
}

/**
 * The page's figure columns, then Share when the key adds up (`whole` is
 * what shares are of; null leaves Share out). None sorts.
 */
function usageGroupColumns(
  config: UsageTableConfig,
  whole: number | null
): GroupColumn<UsageRow, ProcessUsage>[] {
  const figures = config.columns.map(
    (c): GroupColumn<UsageRow, ProcessUsage> => ({
      id: c.label,
      header: c.label,
      align: "right",
      sortable: false,
      group: (r) => (
        <Figure strong={c.ranked === true}>{c.format(r.app)}</Figure>
      ),
      member: (p) => <Figure strong={false}>{c.format(p)}</Figure>,
    })
  );
  if (whole === null) return figures;
  const meter = (share: number | null, muted: boolean) => (
    <MeterCell
      fraction={share === null ? null : share / 100}
      fill={muted ? "var(--color-fg-faint)" : "var(--a)"}
    >
      {formatPercent(share, { decimals: 1 })}
    </MeterCell>
  );
  return [
    ...figures,
    {
      id: "share",
      header: "Share",
      align: "right",
      group: (r) => meter(r.share, false),
      member: (p) => meter(percentOf(usageValue(config.by, p), whole), true),
    },
  ];
}

function GpuShortfallNote({ data }: { data: UsageByApp }) {
  const short = gpuShortfall(data);
  if (short === null) return null;
  return (
    <AppsNote>
      GPU time was measured for{" "}
      <span className="figures">{formatSpan(short.gpuMs)}</span> of the{" "}
      <span className="figures">{formatSpan(short.coveredMs)}</span> sampled.
      Averages are over the measured time.
    </AppsNote>
  );
}

/** A range with no process sample in it: a hatched box, as on Network. */
function Unrecorded({ sinceMs }: { sinceMs: number | null }) {
  return (
    <UnrecordedRange>
      {sinceMs === null ? (
        "No process data for this range"
      ) : (
        <>
          No process data · StatGlass started counting at{" "}
          <span className="figures">{formatClockSeconds(sinceMs)}</span>
        </>
      )}
    </UnrecordedRange>
  );
}

/**
 * "Other apps" and "System and other" after the apps: their figures and
 * share, an empty selection gutter and actions cell, since there is nothing
 * to select or quit.
 */
function RestRows({
  rows,
  config,
  share,
  actions,
}: {
  rows: readonly RemainderRow[];
  config: UsageTableConfig;
  share: boolean;
  /** The table has the selection gutter and the actions column. */
  actions: boolean;
}) {
  return rows.map((row, i) => (
    <OtherAppsRow
      key={row.kind}
      name={row.name}
      system={row.kind === "system"}
      first={i === 0}
      indent
      selectionCell={actions ? <TableCell aria-label="Selection" /> : undefined}
      cellClassName={REST_CELL}
    >
      {config.columns.map((c) => (
        <TableCell key={c.label} className={cn(REST_CELL, "text-right")}>
          <Figure strong={false}>{c.format(row.figures)}</Figure>
        </TableCell>
      ))}
      {share && <ShareCell share={row.share} muted cellClassName={REST_CELL} />}
      {actions && <TableCell />}
    </OtherAppsRow>
  ));
}
