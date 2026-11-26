/** History event labels that follow the phone's temperature preference. */
import { alertCauseLabel } from "@core/alerts";
import { eventLabel } from "@core/events";
import type { TemperatureUnits } from "@core/format";
import type { Event } from "@core/generated/types";
import { useCallback } from "react";

/** Format chart events using the selected units for temperature alerts. */
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
