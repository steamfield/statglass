/**
 * The series the page's host measures right now, for deciding which metrics a rule
 * may watch (`availableMetrics`, `seriesChoices` in `@core/alerts`).
 */
import { useHost } from "~/stores/host-store";
import { currentLayout } from "~/stores/live-selectors";

const NONE: readonly string[] = [];

/**
 * The current live layout's display-form series keys ("fan.rpm{fan=0}"),
 * empty before the first layout. The array is the layout's own, so the
 * reference changes only when a new layout arrives and a live tick never
 * re-renders the caller. The dashboard scopes the store to the host whose rules
 * the page shows.
 */
export function useSeriesKeys(): readonly string[] {
  return useHost((state) => currentLayout(state)?.keys ?? NONE);
}
