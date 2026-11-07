import { usageHistorical } from "@core/chart-range";
import { useModuleRange } from "~/stores/chart-range";

/** The module range's fixed end, or null while it follows now (or outside a range provider). */
export function useModuleEnd(): number | null {
  return useModuleRange()?.endMs ?? null;
}

/**
 * Whether per-app usage for a `windowMs` chart window comes from retained
 * history rather than the live usage ring (`usageHistorical`).
 */
export function useUsageHistorical(windowMs: number): boolean {
  return usageHistorical({ windowMs, endMs: useModuleEnd() });
}
