import type { TemperatureUnits } from "@core/format";
import { getLocales } from "expo-localization";

export function useTemperatureUnits(): TemperatureUnits {
  return getLocales()[0].temperatureUnit === "fahrenheit" ? "F" : "C";
}
