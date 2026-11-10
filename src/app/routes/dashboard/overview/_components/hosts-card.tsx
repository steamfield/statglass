import { formatPercent } from "@core/format";
import type { RemoteHostRecord } from "@core/generated/bindings";
import { connectionLabel } from "@core/remote-hosts";
import { useId } from "react";
import { Link } from "react-router";
import { ChartHistoryStatus } from "~/components/chart-history-status";
import { TruncatedText } from "~/components/truncated-text";
import { useRemoteHosts } from "~/hooks/use-remote-hosts";
import { useHostSelection } from "~/lib/host-selection";
import { Card } from "~/widgets/card";
import type { Corner } from "~/widgets/lib/accent";

/** At most this many hosts; the Hosts page lists the rest. */
const MAX_ROWS = 6;

interface HostRow {
  id: string;
  name: string;
  /** "CPU 18% · Mem 52%" when connected, otherwise the connection state. */
  detail: string;
  connected: boolean;
}

/**
 * The hosts the dashboard isn't showing (phase 2b): every saved remote host
 * with its live CPU and memory share, and This Mac while a remote host is
 * selected. A row switches the dashboard to that host. The readings are the
 * registry's live ones, so the card doesn't follow the chart window; it says
 * how many hosts are connected now.
 */
export function OverviewHostsCard({ origin }: { origin: Corner }) {
  const titleId = useId();
  const selection = useHostSelection();
  const remotes = useRemoteHosts();
  const rows = selection
    ? hostRows(selection.hosts, selection.selected, remotes.data ?? [])
    : [];
  const remoteRows = rows.filter(
    (row) => row.id !== localId(selection?.hosts ?? [])
  );
  const connected = remoteRows.filter((row) => row.connected).length;
  const more = rows.length - MAX_ROWS;

  return (
    <Card
      accent="cpu"
      origin={origin}
      variant="chart"
      labelledBy={titleId}
      className="flex min-w-0 flex-col gap-3 px-4 py-3.5"
    >
      <header className="flex items-baseline justify-between gap-3">
        <h3 id={titleId} className="font-semibold text-body">
          <Link
            to="/dashboard/hosts"
            className="rounded-control outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Other hosts
          </Link>
        </h3>
        {remoteRows.length > 0 && (
          <span className="figures text-label text-muted-foreground">
            {connected} of {remoteRows.length} connected
          </span>
        )}
      </header>
      {!selection || remotes.isPending ? (
        <ChartHistoryStatus loading />
      ) : (
        <ul aria-label="Other hosts" className="flex flex-col gap-1">
          {rows.slice(0, MAX_ROWS).map((row) => (
            <li key={row.id} className="group relative">
              {/* The label keeps row clicks native without nesting tooltip focus in the button. */}
              <label
                htmlFor={`${titleId}-${row.id}`}
                className="relative z-10 flex w-full items-baseline justify-between gap-3 rounded-control py-1 text-left text-small group-hover:bg-muted"
              >
                <TruncatedText
                  className="min-w-0 text-fg-subtle"
                  text={row.name}
                />
                <span
                  className={`shrink-0 text-label ${row.connected ? "figures text-fg-subtle" : "text-muted-foreground"}`}
                >
                  {row.detail}
                </span>
              </label>
              <button
                id={`${titleId}-${row.id}`}
                type="button"
                aria-description="Show this host's metrics"
                className="absolute inset-0 rounded-control outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => selection.select(row.id)}
              />
            </li>
          ))}
        </ul>
      )}
      {more > 0 && (
        <Link
          to="/dashboard/hosts"
          className="figures self-start rounded-control text-label text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {more} more on Hosts
        </Link>
      )}
    </Card>
  );
}

function localId(hosts: readonly { id: string; is_local: boolean }[]) {
  return hosts.find((host) => host.is_local)?.id;
}

/** Saved order, minus the host on screen; This Mac first when it's not. */
export function hostRows(
  hosts: readonly { id: string; is_local: boolean }[],
  selected: string,
  remotes: readonly RemoteHostRecord[]
): HostRow[] {
  const local = localId(hosts);
  const rows: HostRow[] =
    local !== undefined && local !== selected
      ? [{ id: local, name: "This Mac", detail: "Local", connected: false }]
      : [];
  for (const remote of remotes) {
    if (remote.config.id === selected) continue;
    const { status } = remote;
    const connected = status.state === "connected";
    rows.push({
      id: remote.config.id,
      name: remote.config.name,
      detail: connected
        ? `CPU ${formatPercent(status.cpu_pct)} · Mem ${formatPercent(status.memory_pct)}`
        : connectionLabel(remote),
      connected,
    });
  }
  return rows;
}
