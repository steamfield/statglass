/** Stripe pitch of the gap hatch, px (design-system.md "Gaps", `bg-gap-hatch`). */
export const HATCH_PX = 7;
/** The dense variant for small cells (`bg-gap-hatch-dense`). */
export const DENSE_HATCH_PX = 4;

/** What `strokeHatch` draws with; a canvas 2D context satisfies it. */
export type HatchContext = Pick<
  CanvasRenderingContext2D,
  | "save"
  | "clip"
  | "beginPath"
  | "moveTo"
  | "lineTo"
  | "stroke"
  | "restore"
  | "strokeStyle"
  | "lineWidth"
>;

/**
 * The gap hatch on a canvas: 1 px diagonal stripes `spacing` apart over the
 * box at `x, y`, clipped to the current path (build the cell's path first).
 * The canvas counterpart of the `bg-gap-hatch` utilities.
 */
export function strokeHatch(
  ctx: HatchContext,
  box: { x: number; y: number; width: number; height: number },
  color: string,
  spacing: number = HATCH_PX
): void {
  const { x, y, width, height } = box;
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = -height; k < width; k += spacing) {
    ctx.moveTo(x + k, y + height);
    ctx.lineTo(x + k + height, y);
  }
  ctx.stroke();
  ctx.restore();
}
