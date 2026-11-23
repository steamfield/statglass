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
import { targetKey } from "@core/process-selection";
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
import { memo, type ReactNode, useMemo, useState } from "react";
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
import { useCanSignal } from "~/hooks/use-edition";
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
  // for at mount, so the table's first render already knows them.
  const canSignal = useCanSignal();
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
  /** Selection and Quit are offered here. */
  canSignal: boolean;
  /** The live batch by app; null where Quit is not offered or before it arrives. */
  running: RunningApps | null;
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
        scopeKey={scopeKey}
      />
    </>
  );
}

const MemoUsageBody = memo(UsageBody);

/**
 * The apps on the shared grouped table. Rust ranks them, so the order is
 * the answer's. An app row quits what Quit on that app acts on in the live
 * batch (`running`), so every table quits an app the same way; an app with
 * nothing running offers nothing. Rows and columns are rebuilt only
 * when the answer, the query or the running processes change, not each tick.
 */
function UsageTable({
  data,
  config,
  query,
  canSignal,
  running,
  scopeKey,
}: UsageTableProps) {
  const location = useLocation();
  const back = `${location.pathname}${location.search}`;
  const { by } = config;
  const ranked = useMemo(() => usageRows(data, by, query), [data, by, query]);
  const rows = useMemo(
    () => usageGroupRows(ranked, running, back),
    [ranked, running, back]
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
    <div className="overflow-x-auto">
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
                actions={canSignal}
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

/**
 * How the usage answer reads as app groups. Members are the processes the
 * answer lists (the search matches while searching); running ones act on
 * themselves and link to their detail page, exited ones offer nothing.
 */
function usageGroupRows(
  ranked: readonly UsageRow[],
  running: RunningApps | null,
  back: string
): GroupRows<UsageRow, ProcessUsage> {
  const backQuery = `?back=${encodeURIComponent(back)}`;
  const targets = (r: UsageRow) => appQuitTargets(running, r.app.name);
  return {
    groups: ranked,
    key: (r) => `app:${r.app.name}`,
    name: (r) => r.app.name,
    count: (r) => r.app.processes.length,
    members: (r) => r.processes,
    forcedOpen: (r) => r.matchedInside,
    targets,
    unavailable: (r) => (targets(r).length === 0 ? NOT_RUNNING : undefined),
    memberKey: targetKey,
    memberName: (p) => p.name,
    memberPid: (p) => p.pid,
    memberHref: (p) =>
      p.running
        ? `/dashboard/processes/${p.pid}/${p.start_time_us}${backQuery}`
        : undefined,
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
 * The ranked column, high to low, as the table's sort. Rust ranks the rows
 * by the page's key, so the header reports the order and a click on it
 * changes nothing; undefined when no column is ranked.
 */
function rankedSort(config: UsageTableConfig): ClientSort | undefined {
  const ranked = config.columns.find((c) => c.ranked);
  if (ranked === undefined) return undefined;
  return {
    value: { by: ranked.label, dir: "desc" },
    onChange: keepRustOrder,
    client: false,
    nameSortable: false,
  };
}

/** A header click on a Rust-ranked table: the order stays the answer's. */
function keepRustOrder(): void {
  return;
}

/**
 * The page's figure columns, then Share when the key adds up (`whole` is
 * what shares are of; null leaves Share out). Only the ranked column has a
 * sort header, which reports the order Rust ranked the rows in.
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
      sortable: c.ranked === true,
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
