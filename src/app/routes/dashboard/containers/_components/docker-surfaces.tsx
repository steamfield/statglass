import { errorTone } from "@core/command-error";
import {
  formatBytes,
  formatClockSeconds,
  formatPercent,
  MISSING,
} from "@core/format";
import { useMemo } from "react";
import { InlineMessage } from "~/components/inline-message";
import { useIsLocalHost } from "~/hooks/use-is-local-host";
import { useTransport } from "~/lib/transport-context";
import type { PresentationProps } from "~/routes/popover/_components/popover-cards";
import { useSettings } from "~/stores/settings-store";
import { MeterTrack } from "~/widgets/meter-track";
import { ModuleCard } from "~/widgets/module-card";
import {
  useDocker,
  useDockerEvents,
  useDockerHistory,
} from "../_hooks/use-docker";
import {
  containerPath,
  cpuLeader,
  dockerErrorMessage,
  statusLabel,
} from "../_lib/presentation";
import { ContainerHistory } from "./container-history";

function LivePopoverSummary({ compact = false, onToggle }: PresentationProps) {
  const { snapshot } = useDocker();
  const transport = useTransport();
  const rows = snapshot?.containers;
  const leader = useMemo(() => cpuLeader(rows ?? []), [rows]);
  if (!snapshot) return null;
  if (compact)
    return (
      <ModuleCard
        compact
        onToggle={onToggle}
        accent="cpu"
        title="Containers"
        href="/dashboard/containers"
        onOpen={(route) => void transport.openDashboard(route)}
        value={`${snapshot.aggregate.running} running`}
        notice={
          [
            snapshot.status !== "connected"
              ? statusLabel[snapshot.status]
              : null,
            snapshot.aggregate.partial ? "Partial coverage" : null,
          ]
            .filter(Boolean)
            .join(" · ") || undefined
        }
      >
        <div className="flex items-center gap-2 text-caption text-muted-foreground">
          <span className="figures whitespace-nowrap">
            {snapshot.aggregate.cpu_cores?.toFixed(2) ?? MISSING} cores ·{" "}
            {formatBytes(snapshot.aggregate.working_set_bytes)}
          </span>
          <MeterTrack
            fraction={
              snapshot.containers.length
                ? snapshot.aggregate.running / snapshot.containers.length
                : null
            }
            className="min-w-6 flex-1"
          />
        </div>
      </ModuleCard>
    );
  return (
    <ModuleCard
      onToggle={onToggle}
      accent="cpu"
      title="Containers"
      href="/dashboard/containers"
      onOpen={(route) => void transport.openDashboard(route)}
      value={`${snapshot.aggregate.running} running`}
      footer={
        leader ? (
          <button
            type="button"
            className="block self-start rounded-control text-left text-label text-link underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() =>
              void transport.openDashboard(
                containerPath(leader.engine_id, leader.id)
              )
            }
          >
            {snapshot.status === "connected"
              ? "Highest CPU"
              : "Last observed highest CPU"}{" "}
            among monitored: {leader.name} ·{" "}
            {formatPercent(leader.metrics.cpu_pct)}
          </button>
        ) : null
      }
    >
      <span className="figures block text-label text-muted-foreground">
        {snapshot.aggregate.cpu_cores?.toFixed(2) ?? MISSING} cores ·{" "}
        {formatBytes(snapshot.aggregate.working_set_bytes)} ·{" "}
        {statusLabel[snapshot.status]} ·{" "}
        {snapshot.aggregate.partial ? "Partial coverage" : "Complete coverage"}
        <span className="mt-1 block">
          Observed {formatClockSeconds(snapshot.observed_ms)}
        </span>
      </span>
    </ModuleCard>
  );
}
export function DockerPopoverSummary(props: PresentationProps) {
  const local = useIsLocalHost();
  const shown = useSettings(
    (settings) => settings.docker?.enabled && settings.docker?.show_popover
  );
  return local && shown ? <LivePopoverSummary {...props} /> : null;
}
function LiveTimelineLane({ from, to }: { from: number; to: number }) {
  const { snapshot } = useDocker();
  const engine = snapshot?.engine?.id ?? "";
  const history = useDockerHistory(
    engine,
    null,
    from,
    to,
    snapshot?.generation
  );
  const events = useDockerEvents(engine, null, from, to, snapshot?.generation);
  if (!engine) return null;
  return (
    <section aria-label="Docker timeline" className="flex flex-col gap-2">
      <ContainerHistory
        aggregate
        title="Container workload · CPU"
        metric="cpu_pct"
        page={history.data}
        from={from}
        to={to}
        events={events.data?.events}
      />
      <ContainerHistory
        aggregate
        title="Container workload · Working-set memory"
        metric="working_set_bytes"
        page={history.data}
        from={from}
        to={to}
        events={events.data?.events}
      />
      {events.error && (
        <InlineMessage tone={errorTone(events.error)}>
          Container events unavailable: {dockerErrorMessage(events.error)}
        </InlineMessage>
      )}
      {!!events.data?.coverage.length && (
        <p className="text-label text-muted-foreground">
          Container event history is incomplete in parts of this range.
        </p>
      )}
      {history.error && (
        <InlineMessage tone={errorTone(history.error)}>
          Container history unavailable: {dockerErrorMessage(history.error)}
        </InlineMessage>
      )}
    </section>
  );
}
export function DockerTimelineLane(props: { from: number; to: number }) {
  const local = useIsLocalHost();
  const enabled = useSettings((settings) => settings.docker?.enabled);
  return local && enabled ? <LiveTimelineLane {...props} /> : null;
}
