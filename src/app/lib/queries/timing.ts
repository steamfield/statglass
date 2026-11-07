import { MINUTE_MS } from "@core/time-grid";
/**
 * Query freshness and poll periods shared across families, named once so a
 * cadence reads the same everywhere it is used.
 */

/** How long a history answer stays fresh by default: below the last closed bucket it does not change. */
export const HISTORY_STALE_MS = MINUTE_MS;

/**
 * How long an unobserved answer stays cached (D-127): long enough for Back
 * to return to the same rows, not the library's 5 minutes.
 */
export const QUERY_GC_MS = 30_000;

/** Slow re-reads: ring gaps, battery history, a remote host's history health, overhead. */
export const MINUTE_POLL_MS = MINUTE_MS;

/** Lists that change rarely but should notice a change: disk devices and volumes. */
export const HALF_MINUTE_POLL_MS = 30_000;
