/** Network throughput and interfaces for a host. */
import type { Event, Gap } from "@core/generated/types";
import { currentLayout, held, selectPrimaryIface } from "@core/live-selectors";
import { NETWORK_HERO } from "@core/module-hero";
import { networkSubtitle } from "@core/network-lines";
import { FULL_TABLE } from "@core/process-interest";
import { keyByLabel } from "@core/series-key";
import { DAY_MS } from "@core/time-grid";
import { useMemo } from "react";
import { shallow } from "zustand/shallow";
import { useHostAddresses } from "@/data/addresses";
import { type ModuleRead, useModuleHistory } from "@/data/history";
import {
  remoteStatusLine,
  useHostLive,
  useHostLiveSubscription,
} from "@/data/live";
import { HistoryNotice } from "@/module/history-notice";
import { LiveProcessTable } from "@/module/live-process-table";
import { ModuleFrame } from "@/module/module-frame";
import { ModuleNotice } from "@/module/module-notice";
import type { ModulePageProps } from "@/module/pages/index";
import { useModulePage } from "@/module/use-module-page";
import { Card } from "@/ui/card";
import { NetworkHistoryChart } from "./history-chart";
import { AddressList, InterfaceList, NetworkStats } from "./live-stats";

const PROCESS_VIEW = { ...FULL_TABLE, network: true };
const NO_EVENTS: readonly Event[] = [];
const NO_GAPS: readonly Gap[] = [];
const linkKey = keyByLabel("net.link_rate", "iface");
const NETWORK_KEYS = [NETWORK_HERO.chart.downKey, NETWORK_HERO.chart.upKey];
const NETWORK_READ: ModuleRead = {
  module: "network",
  selection: NETWORK_KEYS.map((metric) => ({ metric, labels: [] })),
  gridKeys: NETWORK_KEYS,
};

/**
 * Bars across the mirrored chart: one per six points, the desktop's narrow-card
 * density (40 bars in a ~220 px plot), so the host averages each bar's bucket.
 */
function mirrorBars(width: number) {
  return Math.min(120, Math.max(20, Math.floor(width / 6)));
}

/** Render the host's mirrored throughput history and interface readings. */
export function NetworkPage({ host, remote }: ModulePageProps) {
  const {
    windowMs,
    setWindowMs,
    width,
    setWidth,
    record,
    connected,
    connection,
    live,
    range,
  } = useModulePage(host, remote);
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
  const subtitle = addresses.subtitle ?? networkSubtitle(primary, link);
  const history = useModuleHistory(
    host,
    NETWORK_READ,
    range,
    width === null ? null : { columns: mirrorBars(width) },
    connected
  );
  const { data, grid, displayedRange, events } = history;
  const hasSamples = useMemo(
    () =>
      Object.values(grid?.values ?? {}).some((series) =>
        series.some((value) => value !== null)
      ),
    [grid]
  );
  return (
    <ModuleFrame
      title="Network"
      subtitle={subtitle}
      range={windowMs}
      onRange={setWindowMs}
      events={events}
      showDate={windowMs >= DAY_MS}
    >
      {connected ? (
        <>
          {addresses.error && <ModuleNotice message={addresses.error} error />}
          {connection.state === "reconnecting" && (
            <ModuleNotice message={connection.label} />
          )}
          <NetworkStats
            host={host}
            live={live}
            link={link}
            stats={data?.stats}
            spanMs={displayedRange.toMs - displayedRange.fromMs}
          />
          <Card
            className="gap-2"
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
            <HistoryNotice
              query={history}
              hostName={record?.display_name}
              hasSamples={hasSamples}
            />
          </Card>
          <InterfaceList host={host} live={live} />
          <AddressList rows={addresses.rows} />
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
