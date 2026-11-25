import { alertCauseLabel } from "@core/alerts";
import { eventLabel } from "@core/events";
import type { TemperatureUnits } from "@core/format";
import type { Event } from "@core/generated/types";
import { useCallback, useMemo } from "react";
import type { HistoryRange } from "@/data/history";

export function useEventsInRange(
  events: readonly Event[] | undefined,
  { fromMs, toMs }: HistoryRange
) {
  // The host can start the read on an earlier tier boundary.
  return useMemo(
    () => events?.filter(({ ts_ms }) => ts_ms >= fromMs && ts_ms <= toMs),
    [events, fromMs, toMs]
  );
}

export function useTemperatureEventLabel(units: TemperatureUnits) {
  return useCallback(
    (event: Event) => {
      const { detail } = event;
      if (detail.kind !== "alert") return eventLabel(event);
      return `Alert · ${alertCauseLabel(detail.cause, {
        temperature: units === "F" ? "fahrenheit" : "celsius",
        memory: "decimal",
        network: "bytes_per_sec",
      })}`;
    },
    [units]
  );
}
