import type { SeriesSelector } from "@core/generated/types";
import { POPOVER_CARD_METRICS } from "@core/popover/series";

/**
 * Every metric the popover reads (cards, header, footer), so its live
 * channel carries only these (D-066 projection): 50 series of the mock's
 * 170-series wide layout, and of the default mock's 110. A metric missing
 * here reads as a gap in the popover, so the popover route test renders
 * every card against this projection. The cards' metrics are shared with
 * the phone; the footer adds StatGlass's own CPU.
 */
export const POPOVER_METRICS = [...POPOVER_CARD_METRICS, "self.cpu"] as const;

export const POPOVER_SERIES: readonly SeriesSelector[] = POPOVER_METRICS.map(
  (metric) => ({ metric, labels: [] })
);
