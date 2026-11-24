/**
 * The `n` rows with the highest `value`, highest first, each with its value.
 * A row whose value is a gap (null) drops out: a missing reading is not a
 * zero and never ranks.
 */
export function topBy<T>(
  rows: readonly T[],
  value: (row: T) => number | null,
  n: number
): { row: T; value: number }[] {
  return rows
    .map((row) => ({ row, value: value(row) }))
    .filter((r): r is { row: T; value: number } => r.value !== null)
    .sort((a, b) => b.value - a.value)
    .slice(0, n);
}
