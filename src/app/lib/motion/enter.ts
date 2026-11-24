import type { CSSProperties } from "react";
import styles from "./motion.module.css";

export type EnterVariant = "lift" | "fade";

/**
 * Entrance props for the item at `index` in a surface's reading order: a fade
 * plus a 3 px rise (`lift`) or a plain fade, delayed by `index` stagger steps
 * (capped). Spread onto an existing element so grids and stacks gain no
 * wrapper:
 *
 *   const e = enter(i);
 *   <div className={cn("...", e.className)} style={{ ...style, ...e.style }} />
 *
 * Runs once per mount. Dashboard pages enter through `usePageEntrance`
 * instead, which the shell applies.
 */
export function enter(
  index: number,
  variant: EnterVariant = "lift"
): { className: string; style: CSSProperties } {
  return {
    className: styles[variant] ?? "",
    style: { "--i": index } as CSSProperties,
  };
}
