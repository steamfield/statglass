/** Where a placed marker's pill sits: left edge, row, and how many merged into it. */
export interface MarkerSlot {
  /** Left edge of the pill in px, inside the plot width. */
  leftPx: number;
  row: number;
  /** Markers merged into this one because every row was taken there ("+N"). */
  more: number;
}

export interface MarkerLayout<T> {
  fromMs: number;
  toMs: number;
  widthPx: number;
  /** The pill's width in px. */
  measure: (m: T) => number;
  /**
   * `start`: the pill begins at its time (a Sleep pill, a label hanging
   * right of its rule). `end`: it ends there (an event pill whose dot sits
   * on the time, a label hanging left of its rule).
   */
  side: (m: T) => "start" | "end";
  /** How far the pill reaches past its time on the anchored side, px (default 4). */
  hangPx?: number;
  /** Rows available before markers merge (default 2). */
  rows?: number;
}

/** Space kept between two pills on one row. */
const MIN_GAP_PX = 8;

/**
 * Annotation placement (design-system.md "Annotations": pills must not
 * overlap; later ones move to a second row or merge into a "+N"). Markers are
 * placed left to right. Each takes the first row where it clears every pill
 * already there; when no row has room it merges into the nearest placed
 * marker, which then shows "+N". A pill that would run past either edge is
 * pulled back inside. The result is in time order.
 */
export function layoutMarkers<T extends { tMs: number }>(
  markers: readonly T[],
  {
    fromMs,
    toMs,
    widthPx,
    measure,
    side,
    hangPx = 4,
    rows = 2,
  }: MarkerLayout<T>
): (T & MarkerSlot)[] {
  const placed: (T & MarkerSlot)[] = [];
  const taken: [number, number][][] = Array.from({ length: rows }, () => []);
  const span = Math.max(1, toMs - fromMs);
  for (const m of markers) {
    const w = measure(m);
    const x = ((m.tMs - fromMs) / span) * widthPx;
    let left = side(m) === "end" ? x + hangPx - w : x - hangPx;
    left = Math.max(0, Math.min(left, widthPx - w));
    const right = left + w;
    const row = taken.findIndex((spans) =>
      spans.every(([l, r]) => right + MIN_GAP_PX <= l || left >= r + MIN_GAP_PX)
    );
    if (row === -1 && placed.length > 0) {
      let near = placed[0] as T & MarkerSlot;
      for (const p of placed) {
        if (Math.abs(p.tMs - m.tMs) < Math.abs(near.tMs - m.tMs)) near = p;
      }
      near.more += 1;
      continue;
    }
    const r = row === -1 ? 0 : row;
    taken[r]?.push([left, right]);
    placed.push({ ...m, leftPx: left, row: r, more: 0 });
  }
  return placed.sort((a, b) => a.tMs - b.tMs);
}
