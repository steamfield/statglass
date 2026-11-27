/** Battery readings and charge history for a host. */
import { formatPercent, formatWatts, MISSING, wattsParts } from "@core/format";
import type { PowerSource } from "@core/generated/types";
import { BATTERY_HERO } from "@core/module-hero";
import { moduleState, unavailableText } from "@core/module-state";
import { FULL_TABLE } from "@core/process-interest";
import { DAY_MS } from "@core/time-grid";
import { type ModuleRead, useModuleHistory } from "@/data/history";
import {
  remoteStatusLine,
  useHostLive,
  useHostLiveSubscription,
} from "@/data/live";
import { useTemperatureUnits } from "@/data/temperature-unit";
import { useTemperatureEventLabel } from "@/module/event-labels";
import { EventLabelContext } from "@/module/events-list";
import { LiveProcessTable } from "@/module/live-process-table";
import { ModuleFrame } from "@/module/module-frame";
import { ModuleNotice } from "@/module/module-notice";
import type { ModulePageProps } from "@/module/pages/index";
import { RingCard, RingCards } from "@/module/rings/ring-cards";
import { useWattRingCeiling } from "@/module/rings/watt-ring-ceiling";
import { useModulePage } from "@/module/use-module-page";
import {
  BatteryDayCard,
  batteryTimeField,
  useBatteryReadings,
} from "./battery-day";

const BATTERY_READ: ModuleRead = {
  module: "battery",
  selection: BATTERY_HERO.keys.map((metric) => ({ metric, labels: [] })),
  gridKeys: BATTERY_HERO.keys,
};

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

/** Render battery readings and the selected charge history range. */
export function BatteryPage({ host, remote }: ModulePageProps) {
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
  const units = useTemperatureUnits();
  useHostLiveSubscription(host);
  const caps = useHostLive(host, (s) => s.capabilities);
  const state = moduleState(caps, null, "battery");
  const available = caps !== null && state === "on";
  const history = useModuleHistory(
    host,
    BATTERY_READ,
    range,
    width,
    connected && available
  );
  const readings = useBatteryReadings(host, live);
  const ceiling = useWattRingCeiling(
    host,
    "battery.power",
    live && available,
    readings.powerW,
    10
  );
  const { events } = history;
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
            {!live && <ModuleNotice message={connection.label} />}
            {available && (
              <>
                <BatteryRings readings={readings} ceiling={ceiling} />
                <BatteryDayCard
                  hostName={record?.display_name}
                  history={history}
                  onWidth={setWidth}
                  units={units}
                  readings={readings}
                  clockOffset={range.offsetMs}
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
