import { cpuPowerNote } from "@core/cpu-power-source";
import { formatHoursMinutes, formatWatts } from "@core/format";
import type {
  Capabilities,
  Event,
  HostId,
  PowerSource,
} from "@core/generated/types";
import {
  clusterFreqKey,
  currentLayout,
  held,
  selectPower,
  selectPowerSource,
} from "@core/live-selectors";
import { POWER_HERO } from "@core/module-hero";
import { moduleState, unavailableText } from "@core/module-state";
import { FULL_TABLE } from "@core/process-interest";
import { parseLabels } from "@core/series-key";
import { DAY_MS, MINUTE_MS } from "@core/time-grid";
import { useMemo, useState } from "react";
import { View } from "react-native";
import { shallow } from "zustand/shallow";
import {
  HISTORY_MODULES,
  type HistoryRange,
  useHistoryRange,
  useModuleHistory,
} from "@/data/history";
import { useHosts } from "@/data/hosts-list";
import {
  useConnection,
  useHostLive,
  useHostLiveSubscription,
} from "@/data/live";
import { useTemperatureUnits } from "@/data/temperature-unit";
import { EventLabelContext } from "@/module/events-list";
import { HistoryNotice } from "@/module/history-notice";
import { LiveProcessTable } from "@/module/live-process-table";
import { ModuleChart } from "@/module/module-chart";
import { ModuleFrame } from "@/module/module-frame";
import { ModuleNotice } from "@/module/module-notice";
import { EmbeddedBatteryDay } from "@/module/pages/battery/battery-day";
import type { ModulePageProps } from "@/module/pages/index";
import { StatStrip } from "@/module/stat-strip";
import { Card } from "@/ui/card";
import { Text } from "@/ui/text";
import { BarSwatch } from "@/widgets/stack-bar";
import { useEventsInRange, useTemperatureEventLabel } from "./history-events";
import { PowerRings } from "./power-rings";
import { ThermalHistory } from "./thermal-history";

const COMPONENTS = [
  { key: "cpu", label: "CPU" },
  { key: "gpu", label: "GPU" },
  { key: "ane", label: "ANE" },
  { key: "dram", label: "DRAM" },
] as const;
const SYSTEM_KEY = "power.system";

function subtitle(
  source: PowerSource | null,
  watts: number | null,
  remaining: number | null
) {
  if (source === null) return null;
  const label =
    source === "battery"
      ? "On battery"
      : source === "unknown"
        ? "Power source unknown"
        : "On power adapter";
  const time =
    source === "battery" && remaining !== null
      ? ` · ${formatHoursMinutes(remaining * MINUTE_MS)} remaining`
      : "";
  return `${label} · ${formatWatts(watts)} system draw${time}`;
}

function useRailItems(host: HostId, live: boolean) {
  const layout = useHostLive(host, currentLayout);
  const rails = useMemo(
    () =>
      (layout?.byMetric.get("power.sensor") ?? []).map((key) => ({
        key,
        label: parseLabels(key).name ?? key,
      })),
    [layout]
  );
  const values = useHostLive(
    host,
    (s) => rails.map(({ key }) => (live ? held(s, key) : null)),
    shallow
  );
  return rails.map(({ label }, index) => ({
    label,
    value: formatWatts(values[index]),
  }));
}

function powerAvailability(caps: Capabilities | null) {
  const state = moduleState(caps, null, "power");
  const power = caps !== null && state === "on";
  const sensorCap = caps?.modules.sensors;
  const sensors = typeof sensorCap === "object" && "available" in sensorCap;
  const message =
    state === "unknown_chip"
      ? "Power & Sensors is not available on this Mac."
      : caps !== null && !power && !sensors
        ? (unavailableText(state, "host") ??
          "Power & Sensors is not available.")
        : null;
  return {
    power,
    sensors,
    message,
    battery: caps !== null && moduleState(caps, null, "battery") === "on",
  };
}

export function PowerPage({
  host,
  range: defaultRange,
  remote,
}: ModulePageProps) {
  const [windowMs, setWindowMs] = useState(defaultRange);
  const [width, setWidth] = useState<number | null>(null);
  const hostRecord = useHosts().data?.find(({ id }) => id === host);
  const clockOffset = remote?.clock_offset_ms ?? 0;
  const range = useHistoryRange(windowMs, clockOffset);
  const connected = remote === undefined || remote.state === "connected";
  useHostLiveSubscription(host);
  const connection = useConnection(host, remote, null);
  const live = connection.state === "live";
  const available = useHostLive(
    host,
    ({ capabilities }) => powerAvailability(capabilities),
    shallow
  );
  const history = useModuleHistory(
    host,
    "power",
    range,
    width,
    connected && available.power
  );
  const units = useTemperatureUnits();
  const formatEvent = useTemperatureEventLabel(units);
  const events = useEventsInRange(history.data?.events, history.displayedRange);
  const source = useHostLive(host, selectPowerSource);
  const remaining = useHostLive(host, (s) => held(s, "battery.time_remaining"));
  const system = useHostLive(host, (s) => (live ? held(s, SYSTEM_KEY) : null));
  const pCluster = hostRecord?.info.cpu_topology.find(
    ({ kind }) => kind !== "efficiency"
  );
  const { title } = HISTORY_MODULES.power;
  const showSections = connected && available.message === null;
  const notice = powerNotice(connection, connected ? available.message : null);

  return (
    <EventLabelContext.Provider value={formatEvent}>
      <ModuleFrame
        title={title}
        subtitle={
          live && available.power ? subtitle(source, system, remaining) : null
        }
        range={windowMs}
        onRange={setWindowMs}
        events={events}
        showDate={windowMs >= DAY_MS}
      >
        {notice && <ModuleNotice message={notice} />}
        {showSections && (
          <>
            <PowerRings
              host={host}
              live={live}
              units={units}
              pFreqKey={pCluster ? clusterFreqKey(pCluster.name) : ""}
              source={live ? source : null}
              systemW={system}
              hasPower={available.power}
              showPassiveCooling={
                available.sensors && hostRecord?.info.os === "mac_os"
              }
            />
            {available.power && (
              <PowerDraw
                host={host}
                hostName={hostRecord?.display_name}
                history={history}
                onWidth={setWidth}
                live={live}
                range={range}
                clockOffset={clockOffset}
                events={events}
                formatEvent={formatEvent}
              />
            )}
            {available.sensors && (
              <ThermalHistory
                host={host}
                hostName={hostRecord?.display_name}
                range={range}
                live={live}
                units={units}
              />
            )}
            {available.battery && (
              <EmbeddedBatteryDay
                host={host}
                hostName={hostRecord?.display_name}
                clockOffset={clockOffset}
                live={live}
                units={units}
              />
            )}
            <LiveProcessTable host={host} sort="energy" view={FULL_TABLE} />
          </>
        )}
      </ModuleFrame>
    </EventLabelContext.Provider>
  );
}

function powerNotice(
  connection: ReturnType<typeof useConnection>,
  unavailable: string | null
) {
  return unavailable ?? (connection.state === "live" ? null : connection.label);
}

function PowerDraw({
  host,
  hostName,
  history,
  onWidth,
  live,
  range,
  clockOffset,
  events,
  formatEvent,
}: {
  host: HostId;
  hostName: string | undefined;
  history: ReturnType<typeof useModuleHistory>;
  onWidth(width: number): void;
  live: boolean;
  range: HistoryRange;
  clockOffset: number;
  events: readonly Event[] | undefined;
  formatEvent: (event: Event) => string;
}) {
  const { data, grid, displayedRange } = history;
  const { title, accent } = HISTORY_MODULES.power;
  const rails = useRailItems(host, live);
  const power = useHostLive(host, selectPower, shallow);
  const note = cpuPowerNote(live ? power.cpuSource : null);
  const items = power.components
    ? COMPONENTS.map(({ key, label }) => ({
        label,
        value: formatWatts(live ? power[key] : null),
      }))
    : rails;
  const series = useMemo(
    () =>
      POWER_HERO.lines(grid?.values ?? {}).map((line) => ({
        ...line,
        label: "System",
      })),
    [grid]
  );
  const hasSamples = useMemo(
    () => series.some(({ values }) => values.some((value) => value !== null)),
    [series]
  );
  return (
    <>
      <StatStrip
        lead={{
          label: "System",
          value: formatWatts(live ? power.system : null),
          seriesKey: SYSTEM_KEY,
          format: formatWatts,
        }}
        items={items}
        stats={data?.stats ?? []}
      />
      <Card
        className="gap-2"
        testID="history-plot-layout"
        onLayout={({ nativeEvent }) => onWidth(nativeEvent.layout.width)}
      >
        <View className="flex-row items-center gap-1.5">
          <BarSwatch accent={accent} step={1} />
          <Text variant="caption">System</Text>
        </View>
        <ModuleChart
          key={range.toMs - range.fromMs}
          series={series}
          gaps={data?.gaps ?? []}
          ceiling={{ min: POWER_HERO.yAxis.min }}
          format={formatWatts}
          range={displayedRange}
          nowMs={Math.max(range.toMs, displayedRange.toMs)}
          events={events ?? []}
          formatEvent={formatEvent}
          clockOffsetMs={clockOffset}
          height={160}
          accent={accent}
          module="power"
          label={`${title} history`}
          grid={grid}
          loading={history.isPending}
        />
        <HistoryNotice
          query={history}
          hostName={hostName}
          hasSamples={hasSamples}
        />
        {note && <Text variant="caption">{note}</Text>}
      </Card>
    </>
  );
}
