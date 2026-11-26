/**
 * Series the mock computes from other series rather than from a shape of
 * their own: totals over their parts, residency states that are a fixed share
 * of their engine's activity, and the idle state that is what the active ones
 * leave of 100%. The live generator and the history buckets both read them
 * here, so a total's bucket is the sum of its parts' buckets.
 */
import type { SeriesSpec } from "./generator";

/** Whether `spec` is computed from other series (`derive`). */
export function isDerived(spec: SeriesSpec): boolean {
  return (
    spec.sumOf !== undefined ||
    spec.restOf !== undefined ||
    spec.shareOf !== undefined
  );
}

/**
 * A derived series' reading from the readings of the series it depends on,
 * which come earlier in `values`; null when any of them is null.
 */
export function derive(
  values: ArrayLike<number | null>,
  spec: SeriesSpec,
  specs: readonly SeriesSpec[]
): number | null {
  if (spec.shareOf !== undefined) {
    const v = values[spec.shareOf];
    if (v === null || v === undefined) return null;
    return clampRound(v * shareOf(spec, specs), spec);
  }
  const parts = spec.sumOf ?? spec.restOf ?? [];
  let sum = 0;
  for (const p of parts) {
    const v = values[p];
    if (v === null || v === undefined) return null;
    sum += v;
  }
  return clampRound(spec.restOf ? 100 - sum : sum, spec);
}

/** The fraction of its source a `shareOf` series reads: the ratio of their sample values. */
export function shareOf(
  spec: SeriesSpec,
  specs: readonly SeriesSpec[]
): number {
  const source = specs[spec.shareOf ?? -1];
  return source && source.base !== 0 ? spec.base / source.base : 0;
}

/** `v` within the series' range, rounded to the thousandth the engine keeps. */
export function clampRound(v: number, spec: SeriesSpec): number {
  const c = Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, v));
  return Math.round(c * 1000) / 1000;
}
