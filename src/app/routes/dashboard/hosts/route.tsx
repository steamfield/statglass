import { commandErrorText } from "@core/command-error";
import { countNoun } from "@core/format";
import {
  hostsNeedingUpdate,
  localUpdateTarget,
  pushable,
  reachable,
} from "@core/remote-hosts";
import { useState } from "react";
import { CardGrid } from "~/components/card-grid";
import { PageHeader } from "~/components/page-header";
import { QueryNotice } from "~/components/query-notice";
import { Button } from "~/components/ui/button";
import { useLocalUpdateStatus } from "~/hooks/use-local-update-status";
import { useRemoteHosts } from "~/hooks/use-remote-hosts";
import { useHostSelection } from "~/lib/host-selection";
import { AddHostDialog } from "./_components/add-host-dialog";
import { LocalHostCard, RemoteHostCard } from "./_components/host-cards";
import { UpdateAllDialog } from "./_components/update-all-dialog";
import { useHostsRecentInterest } from "./_hooks/use-hosts-recent-interest";

export default function HostsRoute() {
  useHostsRecentInterest();
  const selection = useHostSelection();
  const remotes = useRemoteHosts();
  const [adding, setAdding] = useState(false);
  const [updatingAll, setUpdatingAll] = useState(false);
  const [localUpdate] = useLocalUpdateStatus();
  const local = selection?.hosts.find((host) => host.is_local);
  const records = remotes.data ?? [];
  const behind = records.filter(pushable);
  const updatable = behind.filter(reachable).length;
  const live =
    records.filter(
      (host) =>
        host.status.state === "connected" &&
        host.status.identity_changed === null &&
        host.status.agent_update.kind !== "required"
    ).length + (local ? 1 : 0);
  const updates = hostsNeedingUpdate(records).length;
  const ids = [
    ...(local ? [local.id] : []),
    ...records.map((host) => host.config.id),
  ];
  const subtitle = `${countNoun(ids.length, "host", "hosts")} · ${live} live · ${ids.length - live} not connected${updates ? ` · ${countNoun(updates, "update", "updates")} available` : ""}`;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Hosts"
        subtitle={subtitle}
        actions={
          <div className="flex gap-2">
            {updatable >= 2 && (
              <Button variant="outline" onClick={() => setUpdatingAll(true)}>
                Update all ({updatable})
              </Button>
            )}
            <Button onClick={() => setAdding(true)}>Add host</Button>
          </div>
        }
      />
      <CardGrid items={ids} getKey={(id) => id} minColumnWidth={400}>
        {(id, origin) =>
          local?.id === id ? (
            <LocalHostCard
              host={local}
              origin={origin}
              target={localUpdateTarget(localUpdate)}
            />
          ) : (
            <RemoteHostCard id={id} origin={origin} />
          )
        }
      </CardGrid>
      <QueryNotice
        query={remotes}
        loading="Loading saved hosts…"
        error={(error) => commandErrorText(error, "Couldn't load saved hosts.")}
        empty={
          records.length === 0 &&
          "Add a Linux server or another Mac over SSH to view its live metrics and keep a copy of its history here."
        }
      />
      {adding && <AddHostDialog open onOpenChange={setAdding} />}
      {updatingAll && (
        <UpdateAllDialog remotes={behind} close={() => setUpdatingAll(false)} />
      )}
    </div>
  );
}
