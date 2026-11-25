/** Where a placed marker's pill sits: left edge, row, and how many merged into it. */
export interface MarkerSlot {
  /** Left edge of the pill in px, inside the plot width. */
  leftPx: number;
  row: number;
  /** Markers merged into this one because every row was taken there ("+N"). */
  more: number;
  /** The side the pill hangs on: the asked side, flipped when only the other fits. */
  side: "start" | "end";
  /** The pill's width, narrowed when it fits on neither side of its time. */
  fitPx: number;
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
 * marker, which then shows "+N". A pill that would run past an edge flips to
 * the other side of its time, or, when it fits on neither, takes the roomier
 * side narrowed to fit, so its rule stays on its time; only the hang is
 * pulled inside. The result is in time order.
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
    const x = ((m.tMs - fromMs) / span) * widthPx;
    const { side: s, fitPx: w } = fitSide(measure(m), side(m), {
      start: widthPx - x + hangPx,
      end: x + hangPx,
    });
    let left = s === "end" ? x + hangPx - w : x - hangPx;
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
    placed.push({ ...m, leftPx: left, row: r, more: 0, side: s, fitPx: w });
  }
  return placed.sort((a, b) => a.tMs - b.tMs);
}

/** The side a pill of width `w` hangs on, given the room on each side of its time. */
function fitSide(
  w: number,
  want: "start" | "end",
  room: Record<"start" | "end", number>
): { side: "start" | "end"; fitPx: number } {
  const other = want === "start" ? "end" : "start";
  if (w <= room[want]) return { side: want, fitPx: w };
  if (w <= room[other]) return { side: other, fitPx: w };
  const side = room[want] >= room[other] ? want : other;
  return { side, fitPx: Math.max(0, room[side]) };
}
