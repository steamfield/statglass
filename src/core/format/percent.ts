import { fixed, isPresent, type MaybeNumber, MISSING } from "./number";

const significantFormatters = new Map<number, Intl.NumberFormat>();

export interface PercentOptions {
  /** Default 0 ("18%"). Breakdowns use 1 ("12.4%", "82.0%"). */
  decimals?: number;
  /** Adaptive precision for small percentages, e.g. 0.0173% and 58.6%. */
  significantDigits?: number;
}

/**
 * `value` is already in percent (0 to 100, or above 100 for per-process CPU,
 * "412%"), matching the catalog's `%` unit. No space before the sign.
 */
export function formatPercent(
  value: MaybeNumber,
  { decimals = 0, significantDigits }: PercentOptions = {}
): string {
  if (!isPresent(value)) return MISSING;
  if (significantDigits !== undefined) {
    let formatter = significantFormatters.get(significantDigits);
    if (!formatter) {
      formatter = new Intl.NumberFormat("en-US", {
        maximumSignificantDigits: significantDigits,
      });
      significantFormatters.set(significantDigits, formatter);
    }
    return `${formatter.format(value)}%`;
  }
  return `${fixed(value, decimals)}%`;
}

/**
 * A difference of two percentages in percentage points, one decimal:
 * "3.4 pp". Pair it with `formatSignedDelta` for "+3.4 pp".
 */
export function formatPercentPoints(points: number): string {
  return `${fixed(points, 1)} pp`;
}

/**
 * A layout fraction (0 to 1) as a CSS percentage for `left`, `width` or a
 * custom property: "12.500%". Three decimals keep sub-pixel positions on a
 * wide chart; this is styling, not a displayed figure.
 */
export function cssPercent(fraction: number, decimals = 3): string {
  return `${(fraction * 100).toFixed(decimals)}%`;
}
