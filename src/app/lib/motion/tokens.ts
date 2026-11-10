/** The duration tokens in `src/app/styles/motion.css`, by suffix. */
export type MotionDuration =
  | "tick"
  | "count"
  | "fast"
  | "entry"
  | "enter"
  | "stagger"
  | "crossfade"
  | "scan";

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
 * The value may be in seconds: the production CSS minifier writes `280ms` as
 * `.28s`.
 */
export function motionMs(name: MotionDuration, el?: Element): number {
  const value = rootStyle(el).getPropertyValue(`--motion-${name}`).trim();
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return 0;
  return value.endsWith("ms") ? n : n * 1000;
}

/** `--ease-<name>`, trimmed, or `ease-out` when the token is missing. */
export function motionEase(name: MotionEase, el?: Element): string {
  return rootStyle(el).getPropertyValue(`--ease-${name}`).trim() || "ease-out";
}
