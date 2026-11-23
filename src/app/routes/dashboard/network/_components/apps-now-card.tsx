/**
 * "Apps, now": Network's live per-app rates while Network history is off.
 * Live processes grouped by app on the shared grouped table, so a row quits
 * its app and expands to its processes as on the Processes page.
 */
import type { LiveProcess } from "@core/generated/bindings";
import {
  groupLiveProcesses,
  type LiveGroup,
  netTotal,
} from "@core/process-groups";
import { FULL_TABLE, type ProcessView } from "@core/process-interest";
import { useMemo, useState } from "react";
import { Link, useLocation } from "react-router";
import { AppsNote, AppsShell } from "~/components/app-table";
import type { ColumnSort } from "~/components/data-table";
import { ProcessGroupTable } from "~/components/process-group-table";
import { liveColumns } from "~/components/process-group-table/live-columns";
import { useCanSignal, useEdition } from "~/hooks/use-edition";
import {
  useProcessInterest,
  useProcessRows,
} from "~/hooks/use-process-interest";
import { useUnits } from "~/hooks/use-units";
import { liveGroupRows } from "../../processes/_lib/processes";

/** Groups listed before "Show all". */
const TOP_GROUPS = 12;

/**
 * Every process with network rates. Grouping a top-N batch would undercount
 * groups and could cut the process Quit on an app acts on.
 */
const NETWORK_VIEW: ProcessView = { ...FULL_TABLE, network: true };

const BY_TOTAL: ColumnSort<string> = { by: "netTotal", dir: "desc" };

/**
 * App groups that sent or received something. A group's figures are member
 * sums, so a group with a null total has only baseline samples (D-081).
 */
export function trafficGroups(rows: readonly LiveProcess[]): LiveGroup[] {
  return groupLiveProcesses(rows, "").filter(
    (g) => (netTotal(g.figures) ?? 0) > 0
  );
}

/**
 * "Network history off": no totals and no brush, only live rates per app
 * (D-081), with a way back to the setting.
 */
export function AppsNowCard() {
  useProcessInterest(NETWORK_VIEW);
  const live = useProcessRows();
  const units = useUnits();
  // The App Store edition has no Quit or Force Quit (D-065).
  const canSignal = useCanSignal();
  // Selectability shapes the table (a checkbox gutter): wait for the edition.
  const known = useEdition() !== null;
  const location = useLocation();
  const [sort, setSort] = useState(BY_TOTAL);
  const groups = useMemo(
    () => (live === null ? [] : trafficGroups(live)),
    [live]
  );
  const columns = useMemo(
    () =>
      liveColumns(["netRx", "netTx", "netTotal"], {
        cpuBarMaxPct: 100,
        memUnits: units.bytes,
        rateUnits: units.rate,
      }).map((c) => (c.id === "netTotal" ? { ...c, header: "Total" } : c)),
    [units.bytes, units.rate]
  );

  return (
    <AppsShell title="Apps, now">
      <AppsNote>
        Network history is off, so there are no totals and the chart has no
        brush. Live rates still show.{" "}
        <Link
          to="/dashboard/settings"
          className="rounded-chip text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          Turn it on in Settings
        </Link>
      </AppsNote>
      {known && (
        <ProcessGroupTable
          rows={liveGroupRows(groups, `${location.pathname}${location.search}`)}
          columns={columns}
          nameHeader="App"
          ariaLabel="Network by app, now"
          sort={{ value: sort, onChange: setSort, client: true }}
          limit={TOP_GROUPS}
          freezeOrderOnHover
          selectable={canSignal}
          empty={
            live === null
              ? "Measuring network by process…"
              : "None of your processes sent or received anything."
          }
        />
      )}
    </AppsShell>
  );
}
