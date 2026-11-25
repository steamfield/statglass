/**
 * The stat-list data contract: labelled figures as a strip or a compact
 * grid. It has no geometry, so it has no model; each app renders the data.
 */
import type { Accent, SwatchStep } from "@core/widget-models/tokens";

/** One labelled figure. */
export interface StatListItem {
  label: string;
  value: string;
  /** Muted suffix ("of 72.6 Wh", "W"). */
  unit?: string | undefined;
  /** Muted trailing figures after the value ("2.98 2.71" for load average). */
  secondary?: string | undefined;
  /** Dim the value (Idle on the CPU page, ANE at rest). */
  muted?: boolean;
  /** Legend swatch before the label (popover power: CPU, GPU, ANE, DRAM). */
  swatch?: SwatchStep;
}

/** What every layout shares. */
export interface StatListBase {
  items: StatListItem[];
  /** Defaults to the accent in scope; only used by swatches. */
  accent?: Accent;
}

/**
 * `strip` (default): a page's KPI strip above a chart, wrapping, with an
 * optional hero figure. `grid`: two to four compact cells in equal columns
 * (popover GPU, battery, power; a host row).
 */
export type StatListData = StatListBase &
  (
    | {
        layout?: "strip";
        /** The page's headline figure at hero size (CPU "Total 18%"). */
        hero?: { label: string; value: string; unit?: string | undefined };
      }
    | { layout: "grid"; hero?: never }
  );
