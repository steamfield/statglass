import { commandError, errorTone } from "@core/command-error";
import type { Event, Gap } from "@core/generated/types";
import { currentLayout, held, selectPrimaryIface } from "@core/live-selectors";
import { networkSubtitle } from "@core/network-lines";
import { FULL_TABLE } from "@core/process-interest";
import { keyByLabel } from "@core/series-key";
import { DAY_MS } from "@core/time-grid";
import { useMemo, useState } from "react";
import { View } from "react-native";
import { shallow } from "zustand/shallow";
import { useHostAddresses } from "@/data/addresses";
import {
  historyReadError,
  useHistoryRange,
  useModuleHistory,
} from "@/data/history";
import { useHosts } from "@/data/hosts-list";
import {
  remoteStatusLine,
  useConnection,
  useHostLive,
  useHostLiveSubscription,
} from "@/data/live";
import { LiveProcessTable } from "@/module/live-process-table";
import { ModuleFrame } from "@/module/module-frame";
import { ModuleNotice } from "@/module/module-notice";
import type { ModulePageProps } from "@/module/pages/index";
import { NetworkHistoryChart } from "./history-chart";
import { InterfaceList, NetworkStats } from "./live-stats";

const PROCESS_VIEW = { ...FULL_TABLE, network: true };
const NO_EVENTS: readonly Event[] = [];
const NO_GAPS: readonly Gap[] = [];
const linkKey = keyByLabel("net.link_rate", "iface");

function NetworkHistoryNotice({
  history,
  hostName,
  hasSamples,
}: {
  history: ReturnType<typeof useModuleHistory>;
  hostName: string | undefined;
  hasSamples: boolean;
}) {
  const kind = commandError(history.error)?.kind;
  const retryable =
    kind === "remote_busy" ||
    kind === "remote_unreachable" ||
    kind === "internal";
  const retryingBusy =
    commandError(history.failureReason)?.kind === "remote_busy";
  if (history.isPending || (history.isFetching && (retryable || retryingBusy)))
    return <ModuleNotice message="Loading history…" />;
  if (history.isError)
    return (
      <ModuleNotice
        message={historyReadError(history.error, hostName)}
        error={errorTone(history.error) === "error"}
        onRetry={retryable ? () => void history.refetch() : undefined}
      />
    );
  return hasSamples ? null : (
    <ModuleNotice message="No samples in this range" />
  );
}

export function NetworkPage({
  host,
  range: defaultRange,
  remote,
}: ModulePageProps) {
  const [windowMs, setWindowMs] = useState(defaultRange);
  const [width, setWidth] = useState<number | null>(null);
  const hostName = useHosts().data?.find(({ id }) => id === host)?.display_name;
  const connected = remote === undefined || remote.state === "connected";
  const connection = useConnection(host, remote, null);
  const live = connection.state === "live";
  const range = useHistoryRange(windowMs, remote?.clock_offset_ms ?? 0);
  useHostLiveSubscription(host);
  const { primary, link } = useHostLive(
    host,
    (state) => {
      if (!live || currentLayout(state) === null)
        return { primary: null, link: null };
      const primary = selectPrimaryIface(state);
      return {
        primary,
        link: primary === null ? null : held(state, linkKey(primary)),
      };
    },
    shallow
  );
  const addresses = useHostAddresses(host, connected);
  const addressError = addresses.line === null ? addresses.hint : null;
  const subtitle =
    addresses.supported && addresses.line !== null
      ? addresses.line
      : networkSubtitle(primary, link);
  const history = useModuleHistory(host, "network", range, width, connected);
  const { data, grid, displayedRange } = history;
  const hasSamples = useMemo(
    () =>
      Object.values(grid?.values ?? {}).some((series) =>
        series.some((value) => value !== null)
      ),
    [grid]
  );
  const events = useMemo(
    () =>
      data?.events.filter(
        ({ ts_ms }) =>
          ts_ms >= displayedRange.fromMs && ts_ms <= displayedRange.toMs
      ),
    [data, displayedRange]
  );
  return (
    <ModuleFrame
      title="Network"
      subtitle={subtitle}
      subtitleHint={addressError === null ? addresses.hint : null}
      subtitleDetail={addresses.ipv6}
      range={windowMs}
      onRange={setWindowMs}
      events={events}
      showDate={windowMs >= DAY_MS}
    >
      {connected ? (
        <>
          {addressError && <ModuleNotice message={addressError} error />}
          {connection.state === "reconnecting" && (
            <ModuleNotice message={connection.label} />
          )}
          <NetworkStats host={host} live={live} link={link} />
          <View
            className="gap-2 rounded-xl border border-border bg-card p-3"
            testID="history-plot-layout"
            onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
          >
            <NetworkHistoryChart
              key={windowMs}
              grid={grid}
              range={displayedRange}
              nowMs={Math.max(range.toMs, displayedRange.toMs)}
              loading={history.isPending}
              hasSamples={hasSamples}
              gaps={data?.gaps ?? NO_GAPS}
              events={events ?? NO_EVENTS}
            />
            <NetworkHistoryNotice
              history={history}
              hostName={hostName}
              hasSamples={hasSamples}
            />
          </View>
          <InterfaceList host={host} live={live} />
        </>
      ) : (
        <ModuleNotice
          message={remoteStatusLine(remote)?.label ?? "Reconnecting"}
        />
      )}
      <LiveProcessTable host={host} sort="net_total" view={PROCESS_VIEW} />
    </ModuleFrame>
  );
}
