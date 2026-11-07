/** A dot where the crosshair crosses one series, `top` px into the plot. */
export interface CrosshairDot {
  key: string;
  top: number;
  /** The series ink. */
  color: string;
}

/** CSS `left` of `fraction` across a plot starting `inset` px into its parent. */
export const plotLeft = (fraction: number, inset = 0): string =>
  `calc(${inset}px + (100% - ${inset}px) * ${fraction})`;

/**
 * Moves every `paint` crosshair under `root` to `left` (a CSS length), or
 * hides them all: one crosshair across sibling plots, written to the DOM so
 * a pointer move re-renders nothing.
 */
export function paintCrosshairs(root: ParentNode, left: string | null): void {
  root
    .querySelectorAll<HTMLElement>('[data-crosshair="paint"]')
    .forEach((el) => {
      el.hidden = left === null;
      if (left !== null) el.style.left = left;
    });
}

/**
 * The crosshair every chart draws (design system, Crosshair): one vertical
 * line through the plot, with a hollow dot on each series it crosses.
 * Positioned inside the plot's `relative` box at `left`, a px value or a
 * CSS length; `top` and `height` let it run past the plot (the Timeline's
 * reaches into the annotation row). With `paint`, it starts hidden and is
 * moved by `paintCrosshairs`, without React.
 */
export function CrosshairLine({
  left,
  top = 0,
  height = "100%",
  dots = [],
  paint = false,
}: {
  left?: number | string;
  top?: number;
  height?: number | string;
  dots?: readonly CrosshairDot[];
  paint?: boolean;
}) {
  return (
    <>
      <div
        aria-hidden
        hidden={paint}
        data-crosshair={paint ? "paint" : ""}
        className="pointer-events-none absolute w-px bg-foreground/45"
        style={{ left, top, height }}
      />
      {dots.map((d) => (
        <span
          key={d.key}
          aria-hidden
          className="pointer-events-none absolute -mt-1 -ml-[3.5px] size-[7px] rounded-full border-[1.5px] bg-background"
          style={{ left, top: d.top, borderColor: d.color }}
        />
      ))}
    </>
  );
}
