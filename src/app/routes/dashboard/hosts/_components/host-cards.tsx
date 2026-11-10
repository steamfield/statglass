import { commandErrorText } from "@core/command-error";
import type { HostRecord } from "@core/generated/bindings";
import { hostKeys } from "@core/query-keys";
import { unwrap } from "@core/transport";
import { useQuery } from "@tanstack/react-query";
import { memo, useState } from "react";
import { useNavigate } from "react-router";
import { QueryNotice } from "~/components/query-notice";
import { useHostRecentHistory } from "~/hooks/use-host-recent-history";
import { useRemoteHosts } from "~/hooks/use-remote-hosts";
import { HostClockContext } from "~/lib/host-clock";
import { useHostSelection } from "~/lib/host-selection";
import { useTransport } from "~/lib/transport-context";
import { HostStoreProvider, useHost, useHostId } from "~/stores/host-store";
import { held } from "~/stores/live-selectors";
import type { Corner } from "~/widgets/lib/accent";
import { version } from "../../../../../../package.json";
import {
  localHostCardModel,
  remoteHostCardModel,
} from "../_lib/host-card-model";
import { HostCard } from "./host-card";
import { HostSettingsDialog } from "./host-settings-dialog";

export const RemoteHostCard = memo(function RemoteHostCard({
  id,
  origin,
}: {
  id: string;
  origin: Corner;
}) {
  const remote = useRemoteHosts((hosts) =>
    hosts.find((host) => host.config.id === id)
  ).data;
  const selection = useHostSelection();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const { history, query } = useHostRecentHistory(
    id,
    remote?.status.clock_offset_ms ?? 0
  );
  const host = selection?.hosts.find((host) => host.id === id);
  if (!remote) return null;
  const model = remoteHostCardModel(remote, host, selection?.hosts);
  const show = () => {
    selection?.select(id);
    void navigate("/dashboard/overview");
  };
  return (
    <>
      <div className="flex h-full flex-col gap-2">
        <HostCard
          model={model}
          remote={remote}
          history={history}
          memoryTotal={host?.info.mem_total_bytes ?? 0}
          origin={origin}
          onShow={show}
          onSelect={() => selection?.select(id)}
          onSettings={() => setEditing(true)}
        />
        <QueryNotice
          query={query}
          loading="Loading recent history…"
          error={(error) =>
            commandErrorText(
              error,
              `Couldn't load recent history for ${model.name}.`
            )
          }
        />
      </div>
      {editing && (
        <HostSettingsDialog remote={remote} close={() => setEditing(false)} />
      )}
    </>
  );
});

function LocalCardData({
  host,
  origin,
  target,
}: {
  host: HostRecord;
  origin: Corner;
  target: string | null;
}) {
  const transport = useTransport();
  const selection = useHostSelection();
  const navigate = useNavigate();
  const vitals = useQuery({
    queryKey: hostKeys.vitals(host.id),
    queryFn: () => unwrap(transport.hostVitals(host.id)),
    refetchInterval: 5000,
  });
  const rr = useQuery({
    queryKey: hostKeys.localRr(host.id),
    queryFn: () => transport.localRrJob(),
    refetchInterval: 60_000,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const { history, query } = useHostRecentHistory(host.id);
  const cpu = useHost((state) =>
    state.stale ? null : held(state, "cpu.total")
  );
  const memory = useHost((state) =>
    state.stale ? null : held(state, "mem.used")
  );
  const model = localHostCardModel(
    host,
    vitals.data ?? null,
    version,
    target,
    cpu,
    memory,
    rr.data ?? null,
    selection?.hosts
  );
  return (
    <div className="flex h-full flex-col gap-2">
      <HostCard
        model={model}
        history={history}
        memoryTotal={host.info.mem_total_bytes}
        origin={origin}
        onSelect={() => selection?.select(host.id)}
        onShow={() => {
          selection?.select(host.id);
          void navigate("/dashboard/overview");
        }}
      />
      <QueryNotice
        query={rr}
        loading="Reading local rr job…"
        error={(error) =>
          commandErrorText(error, "Couldn't read the local rr job.")
        }
      />
      <QueryNotice
        query={vitals}
        loading="Loading vitals…"
        error={(error) =>
          commandErrorText(error, "Couldn't load vitals for This Mac.")
        }
      />
      <QueryNotice
        query={query}
        loading="Loading recent history…"
        error={(error) =>
          commandErrorText(error, "Couldn't load recent history for This Mac.")
        }
      />
    </div>
  );
}

const localNow = () => Date.now();
const LOCAL_SERIES = [
  { metric: "cpu.total", labels: [] },
  { metric: "mem.used", labels: [] },
];
type LocalCardProps = Parameters<typeof LocalCardData>[0];

/** Only This Mac may need a card-owned stream when a remote host is selected. */
export const LocalHostCard = memo(function LocalHostCard(
  props: LocalCardProps
) {
  const current = useHostId();
  if (current === props.host.id) return <LocalCardData {...props} />;
  return (
    <HostClockContext.Provider value={localNow}>
      <HostStoreProvider
        hostId={props.host.id}
        series={LOCAL_SERIES}
        backfillMs={0}
      >
        <LocalCardData {...props} />
      </HostStoreProvider>
    </HostClockContext.Provider>
  );
});
