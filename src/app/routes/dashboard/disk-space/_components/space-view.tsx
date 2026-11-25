import { formatBytes } from "@core/format";
import type { SpaceVolume } from "@core/generated/types";
import { remoteQueryText } from "@core/remote-errors";
import type { ComponentProps, ReactNode } from "react";
import { useState } from "react";
import { InlineMessage } from "~/components/inline-message";
import { PageHeader } from "~/components/page-header";
import {
  currentSpaceStatus,
  useSpaceDropped,
  useSpaceHighlights,
  useSpaceReport,
  useSpaceScan,
  useSpaceStatus,
  useSpaceVolumes,
} from "~/hooks/use-disk-space";
import { useHostNoun } from "~/hooks/use-host-record";
import { DashboardBanners, DashboardBody } from "~/lib/dashboard-shell";
import { useHostId } from "~/stores/host-store";
import { spaceScreen } from "../_lib/space";
import { SpaceLastScan } from "./space-last-scan";
import { SpaceReportView } from "./space-report";
import { SpaceVolumes } from "./space-volumes";

/**
 * Utilities › Disk space (plan/utilities.md, D-153): pick a volume, scan it,
 * and read what uses it. `vol` is the volume in the URL; without one, the volume list.
 * A remote host scans its own volumes over its session (D-117); each host
 * keeps its own scan, so switching hosts starts this view over.
 */
export function SpaceView(props: {
  vol: string | null;
  onVol: (mount: string | null) => void;
}) {
  return <HostSpace key={useHostId()} {...props} />;
}

function SpaceShell({
  subtitle,
  children,
}: {
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeader title="Disk space" subtitle={subtitle} />
      <DashboardBanners />
      <DashboardBody>{children}</DashboardBody>
    </div>
  );
}

function HostSpace({
  vol,
  onVol,
}: {
  vol: string | null;
  onVol: (mount: string | null) => void;
}) {
  const volumes = useSpaceVolumes(true);
  // Keep the settled highlights available when a scan or report closes.
  const highlights = useSpaceHighlights();
  const status = useSpaceStatus(true);
  const current = currentSpaceStatus(status);
  const scanning = current?.phase === "scanning";
  const report = useSpaceReport(
    status.isSuccess,
    scanning ? null : (current?.report_id ?? null)
  );
  const scan = useSpaceScan();
  const dropped = useSpaceDropped(current);
  const [include, setInclude] = useState<ReadonlySet<string>>(new Set());
  const kept = report.data ?? null;
  const { screen, ended } = spaceScreen(current, kept, vol);
  const landingLoading = useLandingLoading(volumes, highlights, screen.mode);
  const busy = scan.starting || scanning;
  const start = (mount: string) => {
    onVol(mount);
    void scan.start(mount, [...include]);
  };
  const volume = volumes.data?.find((v) => v.mount === vol);
  return (
    <SpaceShell subtitle={volumeSubtitle(volume)}>
      <SpaceMessage
        error={scan.error}
        // A host that stops answering mid-scan keeps its last status on
        // screen; the volume list says why on its own.
        lost={screen.mode === "volumes" ? null : status.error}
        ended={ended ?? dropped}
        kept={screen.mode === "report"}
      />
      {screen.mode === "volumes" ? (
        <VolumeList
          query={volumes}
          highlights={highlights}
          loading={landingLoading}
          vol={vol}
          include={include}
          onInclude={(key, on) => setInclude((prev) => toggled(prev, key, on))}
          onScan={start}
          onOpen={onVol}
          reportVolume={kept?.volume.mount ?? null}
          scanningVolume={scanning ? (current?.volume ?? null) : null}
          busy={busy}
        />
      ) : (
        <SpaceReportView
          key={screen.reportId}
          reportId={screen.reportId}
          status={screen.mode === "scan" ? screen.status : null}
          report={screen.mode === "report" ? screen.report : null}
          busy={busy}
          onRescan={() => vol && start(vol)}
          onCancel={() => void scan.cancel()}
          onVolumes={() => onVol(null)}
        />
      )}
    </SpaceShell>
  );
}

function useLandingLoading(
  volumes: ReturnType<typeof useSpaceVolumes>,
  highlights: ReturnType<typeof useSpaceHighlights>,
  mode: ReturnType<typeof spaceScreen>["screen"]["mode"]
) {
  const [settled, setSettled] = useState(false);
  const loading =
    volumes.isPending ||
    highlights.isPending ||
    (!settled && (volumes.isFetching || highlights.isFetching));
  // Keep the picker available on return from a scan or report during a refresh.
  if (mode === "volumes" && !loading && !settled) setSettled(true);
  return loading;
}

function toggled(prev: ReadonlySet<string>, key: string, on: boolean) {
  const next = new Set(prev);
  if (on) next.add(key);
  else next.delete(key);
  return next;
}

function volumeSubtitle(volume: SpaceVolume | undefined): string {
  if (!volume) return "Choose a volume to scan";
  return `${volume.name} · ${formatBytes(volume.used_bytes)} of ${formatBytes(volume.total_bytes)} used`;
}

function SpaceMessage({
  error,
  lost,
  ended,
  kept,
}: {
  error: string | null;
  /** Why the scan's status stopped coming, if it did. */
  lost: Error | null;
  ended: string | null;
  kept: boolean;
}) {
  const alert = error ?? (lost && remoteQueryText(lost, "space reports"));
  if (alert) return <InlineMessage tone="error">{alert}</InlineMessage>;
  if (!ended) return null;
  return (
    <InlineMessage tone="status">
      {ended}
      {kept ? " The previous report is shown." : ""}
    </InlineMessage>
  );
}

function VolumeList({
  query,
  highlights,
  loading,
  vol,
  ...props
}: {
  query: ReturnType<typeof useSpaceVolumes>;
  highlights: ReturnType<typeof useSpaceHighlights>;
  loading: boolean;
  vol: string | null;
} & Omit<ComponentProps<typeof SpaceVolumes>, "volumes" | "primaryMount">) {
  const noun = useHostNoun();
  if (loading || !query.data)
    return (
      <InlineMessage tone="status">
        {!loading && query.isError
          ? volumeErrorText(query.error, noun)
          : "Loading volumes…"}
      </InlineMessage>
    );

  const volumes = query.data;
  const boot = volumes.find((volume) => volume.is_boot);
  const selected = volumes.find((volume) => volume.mount === vol);
  const summary = highlights.data ?? null;
  const hasBootReport = boot !== undefined && props.reportVolume === boot.mount;
  const showSummary =
    boot !== undefined &&
    !hasBootReport &&
    (vol === null || selected?.is_boot === true) &&
    summary !== null &&
    summary.folders.length > 0;
  const primaryVolume = hasBootReport ? boot : (selected ?? boot);
  return (
    <>
      {showSummary && (
        <SpaceLastScan
          summary={summary}
          busy={props.busy}
          onScan={() => props.onScan(boot.mount)}
        />
      )}
      <SpaceVolumes
        volumes={volumes}
        primaryMount={showSummary ? null : (primaryVolume?.mount ?? null)}
        {...props}
      />
    </>
  );
}

function volumeErrorText(error: Error, noun: string) {
  if (error.message.includes("edition"))
    return "Space reports are not available in this edition.";
  return (
    remoteQueryText(error, "space reports") ??
    `Couldn't list the volumes on this ${noun}.`
  );
}
