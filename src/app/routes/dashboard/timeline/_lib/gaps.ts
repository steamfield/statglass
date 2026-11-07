/**
 * The Timeline's gap bands (labels, bands and dedupe live in
 * @core/history-state) and the Sleep/Wake annotation row (plan 4.6, design-system.md
 * "Annotations": pills must not overlap; later ones move to a second row or
 * merge into a "+N").
 */

import { formatClock } from "@core/format";
import type { Gap } from "@core/generated/bindings";
import { dedupeGaps, type GapBandSpec, gapBands } from "@core/history-state";
import type { Span } from "./time";

/** A gap band on the Timeline; a module-scoped one covers that lane only. */
export type Band = GapBandSpec;

/** The Timeline's bands: clock times fit on 1h, durations on 24h. */
export function timelineBands(
  gaps: readonly Gap[],
  fromMs: number,
  toMs: number,
  span: Span
): Band[] {
  return gapBands(gaps, fromMs, toMs, {
    style: span === "1h" ? "clock" : "duration",
  });
}

export interface Marker {
  tMs: number;
  /**
   * `event`: a detector or alert pill, drawn ending at its time
   * so its dot sits there.
   */
  kind: "sleep" | "wake" | "event";
  label: string;
}

/** A Sleep marker at each sleep gap's start and a Wake marker at its end. */
export function sleepMarkers(
  gaps: readonly Gap[],
  fromMs: number,
  toMs: number
): Marker[] {
  const out: Marker[] = [];
  for (const g of dedupeGaps(gaps)) {
    if (g.reason !== "sleep") continue;
    if (g.start_ms >= fromMs && g.start_ms < toMs) {
      out.push({
        tMs: g.start_ms,
        kind: "sleep",
        label: `${formatClock(g.start_ms)} Sleep`,
      });
    }
    if (g.end_ms !== null && g.end_ms >= fromMs && g.end_ms < toMs) {
      out.push({
        tMs: g.end_ms,
        kind: "wake",
        label: `${formatClock(g.end_ms)} Wake`,
      });
    }
  }
  return out.sort((a, b) => a.tMs - b.tMs);
}
