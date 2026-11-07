/** A run of consecutive present samples. `start` indexes the input series. */
export interface Run {
  start: number;
  values: number[];
}

/** A run of items drawn as one segment. `start` indexes the input. */
export interface ItemRun<T> {
  start: number;
  items: T[];
}

/**
 * Split items into runs to draw as separate segments. An item that is not
 * `present` is a gap, and a run also breaks between two present neighbours
 * that are not `contiguous` (a skipped bucket, an isolated partial one).
 * Nothing bridges a break. Single-item runs are kept; whether to draw a lone
 * point as a dot is the renderer's call.
 */
export function splitRuns<T, U extends T>(
  items: readonly T[],
  present: (item: T) => item is U,
  contiguous: (previous: U, next: U) => boolean = () => true
): ItemRun<U>[] {
  const runs: ItemRun<U>[] = [];
  let current: ItemRun<U> | null = null;
  items.forEach((item, i) => {
    if (!present(item)) {
      current = null;
      return;
    }
    const previous = current?.items.at(-1);
    if (
      current === null ||
      previous === undefined ||
      !contiguous(previous, item)
    ) {
      current = { start: i, items: [] };
      runs.push(current);
    }
    current.items.push(item);
  });
  return runs;
}

const finite = (v: number | null): v is number =>
  v != null && Number.isFinite(v);

/**
 * Split a series on `null` (and non-finite values) into runs to draw as
 * separate segments. Nothing bridges a gap: no segment, no area, no
 * interpolation across it.
 */
export function splitGaps(series: readonly (number | null)[]): Run[] {
  return splitRuns(series, finite).map((run) => ({
    start: run.start,
    values: run.items,
  }));
}
