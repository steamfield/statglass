import {
  formatPercent,
  formatTemperature,
  formatWattHours,
  MISSING,
  type TemperatureUnits,
} from "@core/format";
import { batteryTime } from "@core/format/battery";
import type { Event, HostId } from "@core/generated/types";
import { historyGrid } from "@core/history-grid";
import { held, selectBattery, selectPowerSource } from "@core/live-selectors";
import type { HostLive } from "@core/live-state";
import { BATTERY_HERO } from "@core/module-hero";
import { DAY_MS } from "@core/time-grid";
import { useRouter } from "expo-router";
import { memo, useMemo, useState } from "react";
import { View } from "react-native";
import { shallow } from "zustand/shallow";
import { CARD_SURFACE } from "@/cards/module-card";
import {
  useHistoryRange,
  useHostHistory,
  type useModuleHistory,
} from "@/data/history";
import { useHostLive } from "@/data/live";
import { ModuleChart } from "@/module/module-chart";
import { HistoryFeedback } from "@/module/pages/power/history-feedback";
import { ListRow } from "@/ui/list-row";
import { Text } from "@/ui/text";
import { StatList } from "@/widgets/stat-list";

const SELECTION = BATTERY_HERO.keys.map((metric) => ({ metric, labels: [] }));

export function useBatteryReadings(host: HostId, live: boolean) {
  return useHostLive(host, live ? selectBatteryReadings : () => EMPTY, shallow);
}

function selectBatteryReadings(s: HostLive) {
  const { charge, health, cycles, timeRemainingMin } = selectBattery(s);
  return {
    charge,
    health,
    cycles,
    timeRemainingMin,
    source: selectPowerSource(s),
    powerW: held(s, "battery.power"),
    systemW: held(s, "power.system"),
    capacityWh: held(s, "battery.capacity_wh"),
    designWh: held(s, "battery.design_wh"),
    tempC: held(s, "battery.temp"),
  };
}

const EMPTY = {
  charge: null,
  timeRemainingMin: null,
  health: null,
  cycles: null,
  source: null,
  powerW: null,
  systemW: null,
  capacityWh: null,
  designWh: null,
  tempC: null,
};

export function batteryTimeField(
  readings: ReturnType<typeof useBatteryReadings>
) {
  const time = batteryTime(readings, readings.source);
  return readings.source === "adapter" || readings.timeRemainingMin === null
    ? { ...time, value: MISSING }
    : time;
}

type ChargeHistory = Pick<
  ReturnType<typeof useModuleHistory>,
  | "data"
  | "displayedRange"
  | "grid"
  | "isPending"
  | "isFetching"
  | "isError"
  | "isSuccess"
  | "error"
  | "failureReason"
  | "refetch"
>;

export function BatteryDayCard({
  hostName,
  history,
  onWidth,
  units,
  readings,
  clockOffset,
  requestedTo,
  events = [],
  formatEvent,
  onOpenBattery,
}: {
  hostName: string | undefined;
  history: ChargeHistory;
  onWidth(width: number): void;
  units: TemperatureUnits;
  readings: ReturnType<typeof useBatteryReadings>;
  clockOffset: number;
  requestedTo: number;
  events?: readonly Event[] | undefined;
  formatEvent?: ((event: Event) => string) | undefined;
  onOpenBattery?: () => void;
}) {
  const { displayedRange, grid, data } = history;
  const { charge, health, cycles, capacityWh, designWh, tempC } = readings;
  const time = batteryTimeField(readings);
  const series = useMemo(
    () =>
      BATTERY_HERO.lines(grid?.values ?? {}).map((line) => ({
        ...line,
        label: "Charge",
      })),
    [grid]
  );
  const hasSamples = useMemo(
    () => series.some(({ values }) => values.some((value) => value !== null)),
    [series]
  );
  return (
    <View
      className={`${CARD_SURFACE} gap-3 p-3`}
      testID="battery-charge-layout"
      onLayout={({ nativeEvent }) => onWidth(nativeEvent.layout.width)}
    >
      <Text variant="cardTitle" accessibilityRole="header">
        {onOpenBattery ? "Battery charge, last 24 hours" : BATTERY_HERO.subject}
      </Text>
      <StatList
        items={[
          { label: "Charge", value: formatPercent(charge) },
          { label: "Health", value: formatPercent(health) },
          {
            label: "Cycles",
            value: cycles === null ? MISSING : String(cycles),
          },
          time,
          {
            label: "Full charge",
            value: formatWattHours(capacityWh),
            ...(capacityWh !== null && {
              unit:
                designWh === null ? "Wh" : `of ${formatWattHours(designWh)} Wh`,
            }),
          },
          { label: "Temperature", value: formatTemperature(tempC, { units }) },
        ]}
      />
      <ModuleChart
        key={displayedRange.toMs - displayedRange.fromMs}
        series={series}
        gaps={data?.gaps ?? []}
        ceiling={100}
        format={formatPercent}
        range={displayedRange}
        nowMs={Math.max(requestedTo, displayedRange.toMs)}
        events={events}
        formatEvent={formatEvent}
        clockOffsetMs={clockOffset}
        height={140}
        accent="battery"
        module="battery"
        label="Battery charge history"
        grid={grid}
        loading={history.isPending}
      />
      <HistoryFeedback
        history={history}
        hostName={hostName}
        hasSamples={hasSamples}
      />
      {onOpenBattery && (
        <ListRow
          title="Open Battery"
          accessory="chevron"
          onPress={onOpenBattery}
        />
      )}
    </View>
  );
}

export const EmbeddedBatteryDay = memo(function EmbeddedBatteryDay({
  host,
  hostName,
  clockOffset,
  live,
  units,
}: {
  host: HostId;
  hostName: string | undefined;
  clockOffset: number;
  live: boolean;
  units: TemperatureUnits;
}) {
  const router = useRouter();
  const [width, setWidth] = useState<number | null>(null);
  const range = useHistoryRange(DAY_MS, clockOffset);
  const query = useHostHistory(host, SELECTION, range, width);
  const displayedRange = query.data?.range ?? range;
  const data = query.data?.page;
  const grid = useMemo(
    () =>
      data
        ? historyGrid(
            data,
            BATTERY_HERO.keys,
            displayedRange.fromMs,
            displayedRange.toMs
          )
        : null,
    [data, displayedRange]
  );
  const readings = useBatteryReadings(host, live);
  return (
    <BatteryDayCard
      hostName={hostName}
      history={{ ...query, grid, data, displayedRange }}
      onWidth={setWidth}
      units={units}
      readings={readings}
      clockOffset={clockOffset}
      requestedTo={range.toMs}
      onOpenBattery={() =>
        router.push({
          pathname: "/(hosts)/[host]/[module]",
          params: { host, module: "battery" },
        })
      }
    />
  );
});
