import { availableMetrics, newRule } from "@core/alerts";
import { useMemo, useState } from "react";
import { PageHeader } from "~/components/page-header";
import { Button } from "~/components/ui/button";
import { useRemoteHosts } from "~/hooks/use-remote-hosts";
import { useHostSelection } from "~/lib/host-selection";
import { useHostId } from "~/stores/host-store";
import { DestinationsPanel } from "./_components/destinations-panel";
import { RecentAlerts } from "./_components/recent-alerts";
import {
  RemoteAlertsPage,
  RemoteAlertsPending,
} from "./_components/remote-alerts-page";
import { RuleDialog, type RuleDraft } from "./_components/rule-dialog";
import { RulesPanel } from "./_components/rules-panel";
import { useSeriesKeys } from "./_hooks/use-series-keys";

/**
 * Alerts (plan/rfc-alerts.md section 5): This Mac's rules, where alerts
 * are sent, and the alerts they fired, in one column as wide as a Settings
 * column. The "Send to" panel owns its destination dialog; the page holds
 * only the rule draft. "New rule" opens
 * the editor on the first metric this Mac measures; it is disabled until
 * one is known.
 */
export default function AlertsRoute() {
  const hostId = useHostId();
  const selected = useHostSelection()?.hosts.find((host) => host.id === hostId);
  const { data: remote, isError } = useRemoteHosts((hosts) =>
    hosts.find((host) => host.config.id === hostId)
  );
  if (remote?.os === "linux")
    return <RemoteAlertsPage key={hostId} remote={remote} />;
  if (!remote && selected && !selected.is_local && selected.info.os === "linux")
    return (
      <RemoteAlertsPending name={selected.display_name} failed={isError} />
    );
  return <LocalAlertsPage />;
}

function LocalAlertsPage() {
  const seriesKeys = useSeriesKeys();
  const firstMetric = useMemo(
    () => availableMetrics(seriesKeys)[0],
    [seriesKeys]
  );
  const [editing, setEditing] = useState<RuleDraft | null>(null);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Alerts"
        actions={
          <Button
            disabled={firstMetric === undefined}
            onClick={() => {
              if (firstMetric === undefined) return;
              setEditing({
                rule: newRule(firstMetric, crypto.randomUUID()),
                isNew: true,
              });
            }}
          >
            New rule
          </Button>
        }
      />
      <div className="flex max-w-2xl flex-col gap-5">
        <RulesPanel onEdit={(rule) => setEditing({ rule, isNew: false })} />
        <DestinationsPanel />
        <RecentAlerts />
      </div>
      <RuleDialog draft={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
