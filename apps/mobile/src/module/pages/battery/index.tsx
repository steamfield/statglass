import { formatPercent, formatWatts, MISSING, wattsParts } from "@core/format";
import type { PowerSource } from "@core/generated/types";
import { moduleState, unavailableText } from "@core/module-state";
import { FULL_TABLE } from "@core/process-interest";
import { DAY_MS } from "@core/time-grid";
import { useState } from "react";
import { useHistoryRange, useModuleHistory } from "@/data/history";
import { useHosts } from "@/data/hosts-list";
import {
  remoteStatusLine,
  useConnection,
  useHostLive,
  useHostLiveSubscription,
} from "@/data/live";
import { useTemperatureUnits } from "@/data/temperature-unit";
import { EventLabelContext } from "@/module/events-list";
import { LiveProcessTable } from "@/module/live-process-table";
import { ModuleFrame } from "@/module/module-frame";
import { ModuleNotice } from "@/module/module-notice";
import type { ModulePageProps } from "@/module/pages/index";
import {
  useEventsInRange,
  useTemperatureEventLabel,
} from "@/module/pages/power/history-events";
import { RingCard, RingCards } from "@/module/pages/power/ring-cards";
import { useWattRingCeiling } from "@/module/pages/power/watt-ring-ceiling";
import {
  BatteryDayCard,
  batteryTimeField,
  useBatteryReadings,
} from "./battery-day";

const SOURCE_TEXT: Record<PowerSource, string> = {
  battery: "On battery",
  charging: "Charging",
  adapter: "On power adapter, not charging",
  unknown: "Power source unknown",
};

function batterySubtitle(readings: ReturnType<typeof useBatteryReadings>) {
  if (readings.source === null) return null;
  const source = SOURCE_TEXT[readings.source];
  const time = batteryTimeField(readings);
  return time.value !== MISSING && readings.source !== "unknown"
    ? `${source} · ${time.value} ${time.label.toLowerCase()}`
    : source;
}

function BatteryRings({
  readings,
  ceiling,
}: {
  readings: ReturnType<typeof useBatteryReadings>;
  ceiling: number;
}) {
  const { charge, health, cycles, powerW, systemW } = readings;
  const time = batteryTimeField(readings);
  const draw = powerW === null ? null : Math.abs(powerW);
  const flow =
    powerW === null
      ? "No reading"
      : Math.abs(powerW) < 0.05
        ? "No current into or out of the battery"
        : powerW < 0
          ? "Drawn from the battery"
          : "Charging the battery";
  return (
    <RingCards>
      <RingCard
        title="Charge"
        accent="battery"
        ring={{
          label: "Battery charge",
          value: charge,
          max: 100,
          format: formatPercent,
          accent: "battery",
        }}
        detail={`${time.label} · ${time.value}`}
      />
      <RingCard
        title="Health"
        accent="battery"
        ring={{
          label: "Battery health",
          value: health,
          max: 100,
          format: formatPercent,
          accent: "battery",
        }}
        detail={`Cycles · ${cycles ?? MISSING}`}
      />
      <RingCard
        title="Power"
        accent="battery"
        unit="W"
        ring={{
          label: "Battery power (W)",
          value: draw,
          max: ceiling,
          format: (value) => wattsParts(value).value,
          accent: "battery",
        }}
        detail={`${flow} · System ${formatWatts(systemW).replace(" ", "\u00a0")}`}
      />
    </RingCards>
  );
}

export function BatteryPage({
  host,
  range: defaultRange,
  remote,
}: ModulePageProps) {
  const [windowMs, setWindowMs] = useState(defaultRange);
  const [width, setWidth] = useState<number | null>(null);
  const hostName = useHosts().data?.find(({ id }) => id === host)?.display_name;
  const connected = remote === undefined || remote.state === "connected";
  const clockOffset = remote?.clock_offset_ms ?? 0;
  const range = useHistoryRange(windowMs, clockOffset);
  const units = useTemperatureUnits();
  useHostLiveSubscription(host);
  const connection = useConnection(host, remote, null);
  const caps = useHostLive(host, (s) => s.capabilities);
  const state = moduleState(caps, null, "battery");
  const available = caps !== null && state === "on";
  const history = useModuleHistory(
    host,
    "battery",
    range,
    width,
    connected && available
  );
  const live = connection.state === "live";
  const readings = useBatteryReadings(host, live);
  const ceiling = useWattRingCeiling(
    host,
    "battery.power",
    live && available,
    readings.powerW,
    10
  );
  const events = useEventsInRange(history.data?.events, history.displayedRange);
  const formatEvent = useTemperatureEventLabel(units);
  return (
    <EventLabelContext.Provider value={formatEvent}>
      <ModuleFrame
        title="Battery"
        subtitle={batterySubtitle(readings)}
        range={windowMs}
        onRange={setWindowMs}
        events={events}
        showDate={windowMs >= DAY_MS}
      >
        {!connected ? (
          <ModuleNotice
            message={remoteStatusLine(remote)?.label ?? "Reconnecting"}
          />
        ) : caps !== null && !available ? (
          <ModuleNotice
            message={
              unavailableText(state, "host") ?? "Battery is not available."
            }
          />
        ) : (
          <>
            {connection.state !== "live" && (
              <ModuleNotice message={connection.label} />
            )}
            {available && (
              <>
                <BatteryRings readings={readings} ceiling={ceiling} />
                <BatteryDayCard
                  hostName={hostName}
                  history={history}
                  onWidth={setWidth}
                  units={units}
                  readings={readings}
                  clockOffset={clockOffset}
                  requestedTo={range.toMs}
                  events={events}
                  formatEvent={formatEvent}
                />
              </>
            )}
          </>
        )}
        {connected && available && (
          <LiveProcessTable host={host} sort="energy" view={FULL_TABLE} />
        )}
      </ModuleFrame>
    </EventLabelContext.Provider>
  );
}
