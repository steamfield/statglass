import { useShallow } from "zustand/react/shallow";
import { type HostLiveState, useHost } from "~/stores/host-store";
import { held, selectBattery } from "~/stores/live-selectors";

/**
 * Battery summary values displayed beside the hourly history.
 * `null` is no current value, never 0.
 */
const selectBatterySummary = (s: HostLiveState) => {
  const { charge, timeRemainingMin, health, cycles } = selectBattery(s);
  return {
    charge,
    timeRemainingMin,
    health,
    cycles,
    capacityWh: held(s, "battery.capacity_wh"),
    designWh: held(s, "battery.design_wh"),
  };
};

export function useBatterySummary() {
  return useHost(useShallow(selectBatterySummary));
}

/** Every battery series' current value (catalog 6.1), for the Battery page. */
export const selectBatteryDetail = (s: HostLiveState) => ({
  ...selectBattery(s),
  ...selectBatterySummary(s),
  powerW: held(s, "battery.power"),
  tempC: held(s, "battery.temp"),
  systemW: held(s, "power.system"),
});

export type BatteryDetail = ReturnType<typeof selectBatteryDetail>;

export function useBatteryDetail(): BatteryDetail {
  return useHost(useShallow(selectBatteryDetail));
}
