/** The hollow gap-edge dot (design-system.md "Gaps"): diameter and stroke, px. */
export const GAP_EDGE_DOT = { size: 7, stroke: 1.5 } as const;

/**
 * A hollow dot where a line meets a gap, or where a one-bucket run stands
 * alone: 7 px, a 1.5 px ring in the series ink over the card. Place it in
 * the plot's `relative` box; `left` is a CSS length along the plot and `top`
 * the y in px, both at the dot's centre.
 */
export function GapEdgeDot({
  left,
  top,
  color,
}: {
  left: string;
  top: number;
  color: string;
}) {
  return (
    <span
      data-gap-edge
      aria-hidden
      className="pointer-events-none absolute -mt-[3.5px] -ml-[3.5px] size-[7px] rounded-full border-[1.5px] bg-card"
      style={{ left, top, borderColor: color }}
    />
  );
}

/**
 * The same dot as a uPlot series `points` option, for canvas charts:
 * drawn only at the indices `filter` returns.
 */
export function gapEdgePoints(
  stroke: string,
  fill: string,
  filter: () => number[]
) {
  return {
    show: true,
    size: GAP_EDGE_DOT.size,
    width: GAP_EDGE_DOT.stroke,
    stroke,
    fill,
    filter,
  };
}
