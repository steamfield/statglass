import { METRIC_CODES, type ThermalState } from "@core/generated/bindings";

/** `thermal.state` (`NSProcessInfo.thermalState`) as the word the UI shows. */
export const THERMAL_LABEL: Record<ThermalState, string> = {
  nominal: "Nominal",
  fair: "Fair",
  serious: "Serious",
  critical: "Critical",
};

const CODE = METRIC_CODES["thermal.state"];

/** The state a `thermal.state` sample codes (`METRIC_CODES`); null for a gap. */
export function thermalState(code: number | null): ThermalState | null {
  if (code === null || !Number.isFinite(code)) return null;
  if (code >= CODE.critical) return "critical";
  if (code >= CODE.serious) return "serious";
  if (code >= CODE.fair) return "fair";
  return "nominal";
}
