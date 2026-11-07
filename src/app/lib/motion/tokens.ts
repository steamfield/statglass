/** The duration tokens in `src/app/styles/motion.css`, by suffix. */
export type MotionDuration =
  | "tick"
  | "count"
  | "fast"
  | "entry"
  | "enter"
  | "stagger"
  | "crossfade";

/** The easing tokens, by suffix. */
export type MotionEase = "out" | "tick";

/**
 * Tokens live on the window root, alongside `data-performance`, so they are
 * read there rather than from the element, which might override them. `el`
 * picks the window when the caller has one (a board or the popover).
 */
function rootStyle(el?: Element): CSSStyleDeclaration {
  return getComputedStyle((el?.ownerDocument ?? document).documentElement);
}

/**
 * `--motion-<name>` in ms: 0 under Reduce Motion and Performance mode, and 0
 * when the token is missing, so a JS tween that reads it never runs then.
 */
export function motionMs(name: MotionDuration, el?: Element): number {
  const ms = Number.parseFloat(
    rootStyle(el).getPropertyValue(`--motion-${name}`)
  );
  return Number.isFinite(ms) ? ms : 0;
}

/** `--ease-<name>`, trimmed, or `ease-out` when the token is missing. */
export function motionEase(name: MotionEase, el?: Element): string {
  return rootStyle(el).getPropertyValue(`--ease-${name}`).trim() || "ease-out";
}
