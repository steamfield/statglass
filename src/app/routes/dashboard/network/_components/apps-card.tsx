/**
 * Network's "Network by app" card: per-app bytes over the chart window or
 * the brushed selection, on the shared grouped table so each app row quits
 * the running app. A fixed range hands off to the recorded usage card.
 */
import type { TimeRange } from "@core/brush";
import {
  formatBytes,
  formatClockSeconds,
  formatPercent,
  formatRate,
  MISSING,
  type RateUnits,
} from "@core/format";
import type { NetworkByApp } from "@core/generated/bindings";
import { networkByAppFailure } from "@core/history-state";
import { appQuitTargets, type RunningApps } from "@core/process-groups";
import { CommandFailure } from "@core/transport";
import { memo, type ReactNode, useMemo, useState } from "react";
import {
  AppsNote,
  AppsShell,
  OtherChip,
  UnrecordedRange,
} from "~/components/app-table";
import {
  type ColumnSort,
  FullWidthRow,
  MeterCell,
} from "~/components/data-table";
import { HistoricalUsageCard } from "~/components/historical-usage-card";
import {
  type GroupColumn,
  type GroupRows,
  ProcessGroupTable,
} from "~/components/process-group-table";
import { SelectionChip } from "~/components/selection-chip";
import { TableCell, TableRow } from "~/components/ui/table";
import { useCanSignalSettled } from "~/hooks/use-edition";
import { useModuleEnd, useUsageHistorical } from "~/hooks/use-module-end";
import { heldFor, useOpenEdge, useRangeScope } from "~/hooks/use-range-scope";
import { useRunningApps } from "~/hooks/use-running-apps";
import { useUnits } from "~/hooks/use-units";
import { cn } from "~/lib/utils";
import {
  useCompleteEdge,
  useLatestBucket,
  useNetworkByApp,
} from "../_hooks/use-network-by-app";
import {
  type AppRow,
  appRows,
  appsTitle,
  firstRecordedMs,
  nowRates,
  openTailS,
  partialCoverage,
  remainderRows,
  unrecorded,
} from "../_lib/apps";

/**
 * Bytes per app over the selection, or over the chart window (D-091) when
 * nothing is selected (D-089). Totals come from `query_network_by_app`; "now" is
 * the latest complete 10 s bucket of the same command, so its names match.
 * The window ends where the engine's complete buckets end, not at the
 * newest sample: the bucket before it may still be waiting on the per-app
 * stream, and counting it would push its interface bytes into "System and
 * other".
 */
export function AppsCard({ windowMs }: { windowMs: number }) {
  const historical = useUsageHistorical(windowMs);
  return historical ? (
    <MemoHistoricalNetworkApps windowMs={windowMs} />
  ) : (
    <LiveAppsCard windowMs={windowMs} />
  );
}

function HistoricalNetworkApps({ windowMs }: { windowMs: number }) {
  const { range } = useRangeScope(windowMs);
  return (
    <HistoricalUsageCard
      range={range}
      by="network"
      accent="net"
      title="Network by app"
    />
  );
}

const MemoHistoricalNetworkApps = memo(HistoricalNetworkApps);

/** "Network by app" sorts by Total until the reader picks another header. */
const BY_TOTAL: ColumnSort<string> = { by: "total", dir: "desc" };

function LiveAppsCard({ windowMs }: { windowMs: number }) {
  const fixed = useModuleEnd() !== null;
  const complete = useCompleteEdge(useOpenEdge());
  const { selection, range, keepPrevious } = useRangeScope(windowMs, complete);
  const totals = useNetworkByApp(range, { keepPrevious });
  const latest = useLatestBucket(complete);
  const units = useUnits();
  // Held here, not in the table, so it survives a brushed range loading.
  const [sort, setSort] = useState(BY_TOTAL);

  const data = heldFor(totals, windowMs);
  const now = useMemo(() => nowRates(latest.data), [latest.data]);
  const rows = useMemo(() => (data ? appRows(data, now) : []), [data, now]);
  const rest = useMemo(() => (data ? remainderRows(data) : []), [data]);
  const shown: TimeRange | null = data
    ? { fromMs: data.from_ms, toMs: data.to_ms }
    : selection;

  let body: ReactNode;
  if (totals.isError) {
    const error = totals.error;
    body = (
      <AppsNote>
        {error instanceof CommandFailure
          ? networkByAppFailure(error.error)
          : "Couldn't load app totals."}
      </AppsNote>
    );
  } else if (!data) {
    body = <AppsNote>Loading app totals…</AppsNote>;
  } else if (unrecorded(data)) {
    body = <Unrecorded data={data} edge={complete} />;
  } else {
    const partial = partialCoverage(data);
    const tail = openTailS(data);
    body = (
      <>
        {partial && (
          <AppsNote>
            Measured for <span className="figures">{partial.measuredS}</span> of{" "}
            <span className="figures">{partial.spanS}</span> s. Network history
            wasn't recording for the rest, so these totals cover{" "}
            <span className="figures">{partial.measuredS}</span> s.
          </AppsNote>
        )}
        {tail > 0 && (
          <AppsNote>
            The last <span className="figures">{tail}</span> s are still being
            measured. These totals update as they close.
          </AppsNote>
        )}
        {data.clamped && (
          <AppsNote>
            App totals here exceed the interface (bytes counted when their app
            was identified), so System and other reads 0 and shares are of the
            table's total.
          </AppsNote>
        )}
        <AppsTable
          rows={rows}
          rest={rest}
          units={units.rate}
          sort={sort}
          onSortChange={setSort}
        />
      </>
    );
  }

  return (
    <AppsShell
      title={appsTitle(selection || fixed ? (shown ?? range) : null, windowMs)}
      aside={selection && shown && <SelectionChip range={shown} />}
    >
      {body}
    </AppsShell>
  );
}

/**
 * A range with nothing recorded: a hatched box naming when Network history started, read from
 * the time after the range.
 */
function Unrecorded({
  data,
  edge,
}: {
  data: NetworkByApp;
  edge: number | null;
}) {
  const after =
    edge !== null && edge > data.to_ms
      ? { fromMs: data.to_ms, toMs: edge }
      : null;
  const later = useNetworkByApp(after);
  const started = later.data ? firstRecordedMs(later.data) : null;
  return (
    <UnrecordedRange>
      {started === null ? (
        "No app data for this range"
      ) : (
        <>
          No app data · Network history started{" "}
          <span className="figures">{formatClockSeconds(started)}</span>
        </>
      )}
    </UnrecordedRange>
  );
}

/**
 * The named apps on the shared grouped table, then the remainder rows and
 * the footnote. An app row has no members (per-app totals carry no
 * processes); it selects and quits the running processes of its app.
 */
function AppsTable({
  rows,
  rest,
  units,
  sort,
  onSortChange,
}: {
  rows: readonly AppRow[];
  rest: readonly AppRow[];
  units: RateUnits;
  sort: ColumnSort<string>;
  onSortChange: (next: ColumnSort<string>) => void;
}) {
  // Null where this view cannot quit (App Store edition, remote hosts).
  const running = useRunningApps();
  // Null while the edition loads: the table waits rather than add its
  // checkbox column under the reader.
  const selectable = useCanSignalSettled();
  const groupRows = useMemo(() => appGroupRows(rows, running), [rows, running]);
  const columns = useMemo(() => appColumns(units), [units]);
  return (
    <ProcessGroupTable
      rows={groupRows}
      columns={columns}
      nameHeader="App"
      ariaLabel="Network by app"
      sort={{ value: sort, onChange: onSortChange, client: true }}
      freezeOrderOnHover
      selectable={selectable}
      after={(colSpan) => (
        <RemainderRows
          rest={rest}
          selectable={selectable === true}
          colSpan={colSpan}
        />
      )}
      empty="No app sent or received anything in this range."
    />
  );
}

/**
 * App rows as groups without members, so no count. Before the first
 * process batch nothing is known to be not running, so no row says so yet.
 * The table breaks sort ties by name,
 * then keeps input order, so ordering the input by key keeps names that
 * collate equal ("é" and "é") in one order across frames.
 */
function appGroupRows(
  rows: readonly AppRow[],
  running: RunningApps | null
): GroupRows<AppRow, never> {
  return {
    groups: [...rows].sort(byKey),
    key: (r) => r.key,
    name: (r) => r.name,
    count: () => null,
    expandable: () => false,
    members: () => [],
    targets: (r) => appQuitTargets(running, r.name),
    unavailable: () => (running === null ? undefined : "Not running"),
    memberKey: () => "",
    memberName: () => "",
    memberPid: () => 0,
    memberTargets: () => [],
  };
}

const byKey = (a: AppRow, b: AppRow) =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

/** Down, Up, Total, Share and Now; every one sorts, unknown values last. */
function appColumns(units: RateUnits): GroupColumn<AppRow, never>[] {
  const bytes = (
    id: string,
    header: string,
    value: (r: AppRow) => number,
    strong = false
  ): GroupColumn<AppRow, never> => ({
    id,
    header,
    align: "right",
    groupValue: value,
    group: (r) => (
      <span className={cn("figures", strong && "text-foreground")}>
        {formatBytes(value(r))}
      </span>
    ),
    member: () => null,
  });
  return [
    bytes("down", "Down", (r) => r.rxBytes),
    bytes("up", "Up", (r) => r.txBytes),
    bytes("total", "Total", (r) => r.totalBytes, true),
    {
      id: "share",
      header: "Share",
      align: "right",
      groupValue: (r) => r.share,
      group: (r) => (
        <MeterCell
          fraction={r.share === null ? null : r.share / 100}
          fill="var(--a)"
        >
          {formatPercent(r.share, { decimals: 1 })}
        </MeterCell>
      ),
      member: () => null,
    },
    {
      id: "now",
      header: "Now",
      align: "right",
      groupValue: (r) => r.nowBps,
      group: (r) => (
        <span className={cn("figures", !r.nowBps && "text-fg-faint")}>
          {formatRate(r.nowBps, { units })}
        </span>
      ),
      member: () => null,
    },
  ];
}

/** Cells of the remainder rows, sized and weighted like the app rows above. */
const REMAINDER_CELL = "whitespace-nowrap px-3 py-0 font-normal";

/**
 * "Other apps", protocol overhead and "System and other", then the
 * footnote. They are not processes: the gutter and actions cells stay empty.
 */
function RemainderRows({
  rest,
  selectable,
  colSpan,
}: {
  rest: readonly AppRow[];
  selectable: boolean;
  colSpan: number;
}) {
  const figure = cn(REMAINDER_CELL, "figures text-right");
  return (
    <>
      {rest.map((r, i) => (
        <TableRow
          key={r.key}
          className={cn(
            "h-[29px] border-border-subtle border-b text-muted-foreground hover:bg-transparent",
            i === 0 && "border-border border-t",
            r.kind === "system" && "border-b-0"
          )}
        >
          {selectable && <TableCell aria-label="Selection" />}
          <TableCell className={REMAINDER_CELL}>
            <span className="inline-flex items-center gap-2 align-middle">
              {/* The chevron's and the initial chip's places in app rows. */}
              <span aria-hidden className="-ml-1 inline-block size-4" />
              {r.kind === "system" ? (
                <OtherChip />
              ) : (
                <span aria-hidden className="inline-block w-4 flex-none" />
              )}
              {r.name}
            </span>
          </TableCell>
          <TableCell className={figure}>{formatBytes(r.rxBytes)}</TableCell>
          <TableCell className={figure}>{formatBytes(r.txBytes)}</TableCell>
          <TableCell className={figure}>{formatBytes(r.totalBytes)}</TableCell>
          <TableCell className={cn(REMAINDER_CELL, "text-right")}>
            <MeterCell
              fraction={r.share === null ? null : r.share / 100}
              fill="var(--color-fg-faint)"
            >
              {formatPercent(r.share, { decimals: 1 })}
            </MeterCell>
          </TableCell>
          <TableCell className={cn(figure, "text-fg-faint")}>
            {MISSING}
          </TableCell>
          {selectable && <TableCell />}
        </TableRow>
      ))}
      <FullWidthRow
        colSpan={colSpan}
        tone="footnote"
        // Lines up with the app names: past the gutter, chevron slot and chip.
        className={cn("pt-0", selectable ? "pl-22" : "pl-14")}
      >
        macOS services (updates, backups, DNS). StatGlass can't see these
        without a helper.
      </FullWidthRow>
    </>
  );
}
