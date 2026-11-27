/** Power draw, sensors and battery history for a host. */
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
import { useMemo } from "react";
import { View } from "react-native";
import { shallow } from "zustand/shallow";
import {
  MODULE_TITLES,
  type ModuleRead,
  useModuleHistory,
} from "@/data/history";
import { useHostLive, useHostLiveSubscription } from "@/data/live";
import { useTemperatureUnits } from "@/data/temperature-unit";
import { useTemperatureEventLabel } from "@/module/event-labels";
import { EventLabelContext } from "@/module/events-list";
import { HistoryNotice } from "@/module/history-notice";
import { LiveProcessTable } from "@/module/live-process-table";
import { ModuleChart } from "@/module/module-chart";
import { ModuleFrame } from "@/module/module-frame";
import { ModuleNotice } from "@/module/module-notice";
import { EmbeddedBatteryDay } from "@/module/pages/battery/battery-day";
import type { ModulePageProps } from "@/module/pages/index";
import { StatStrip } from "@/module/stat-strip";
import { type ModulePage, useModulePage } from "@/module/use-module-page";
import { Card } from "@/ui/card";
import { Text } from "@/ui/text";
import { BarSwatch } from "@/widgets/stack-bar";
import { PowerRings } from "./power-rings";
import { ThermalHistory } from "./thermal-history";

const COMPONENTS = [
  { key: "cpu", label: "CPU" },
  { key: "gpu", label: "GPU" },
  { key: "ane", label: "ANE" },
  { key: "dram", label: "DRAM" },
] as const;
const SYSTEM_KEY = "power.system";
const POWER_READ: ModuleRead = {
  module: "power",
  selection: POWER_HERO.keys.map((metric) => ({ metric, labels: [] })),
  gridKeys: POWER_HERO.keys,
};

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

/** Render available power and sensor sections for the host. */
export function PowerPage({ host, remote }: ModulePageProps) {
  const {
    windowMs,
    setWindowMs,
    width,
    setWidth,
    record: hostRecord,
    connected,
    connection,
    live,
    range,
  } = useModulePage(host, remote);
  useHostLiveSubscription(host);
  const available = useHostLive(
    host,
    ({ capabilities }) => powerAvailability(capabilities),
    shallow
  );
  const history = useModuleHistory(
    host,
    POWER_READ,
    range,
    width,
    connected && available.power
  );
  const units = useTemperatureUnits();
  const formatEvent = useTemperatureEventLabel(units);
  const { events } = history;
  const source = useHostLive(host, selectPowerSource);
  const remaining = useHostLive(host, (s) => held(s, "battery.time_remaining"));
  const system = useHostLive(host, (s) => (live ? held(s, SYSTEM_KEY) : null));
  const pCluster = hostRecord?.info.cpu_topology.find(
    ({ kind }) => kind !== "efficiency"
  );
  const showSections = connected && available.message === null;
  const notice = powerNotice(connection, connected ? available.message : null);

  return (
    <EventLabelContext.Provider value={formatEvent}>
      <ModuleFrame
        title={MODULE_TITLES.power}
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
                clockOffset={range.offsetMs}
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
  connection: ModulePage["connection"],
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
  formatEvent,
}: {
  host: HostId;
  hostName: string | undefined;
  history: ReturnType<typeof useModuleHistory>;
  onWidth(width: number): void;
  live: boolean;
  range: ModulePage["range"];
  formatEvent: (event: Event) => string;
}) {
  const { data, grid, displayedRange, events } = history;
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
          <BarSwatch accent="power" step={1} />
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
          clockOffsetMs={range.offsetMs}
          height={160}
          accent="power"
          module="power"
          label={`${MODULE_TITLES.power} history`}
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
