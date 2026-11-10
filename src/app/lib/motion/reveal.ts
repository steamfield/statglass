import { type RefObject, useLayoutEffect, useRef } from "react";
import { motionEase, motionMs } from "./tokens";

/**
 * Ref for the element that holds a chart's data layers. When `loading` goes from true
 * to false, every `[data-reveal]` element inside it (or the element itself) settles
 * from the baseline once: opacity 0 → 1 and scaleY 0.9 → 1 over `--motion-enter`.
 * Nothing is left on the element afterwards, so nothing can replay.
 */
export function useReveal<T extends HTMLElement>(
  loading: boolean | undefined
): RefObject<T | null> {
  const ref = useRef<T>(null);
  const previous = useRef<boolean | undefined>(undefined);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && previous.current === true && loading !== true) {
      const duration = motionMs("enter", el);
      const targets = el.matches("[data-reveal]")
        ? [el]
        : el.querySelectorAll("[data-reveal]");
      for (const target of targets) {
        if (duration > 0 && typeof target.animate === "function")
          target.animate(
            [
              { opacity: 0, transform: "scaleY(0.9)" },
              { opacity: 1, transform: "none" },
            ],
            { duration, easing: motionEase("out", el), id: "reveal" }
          );
      }
    }
    previous.current = loading;
  }, [loading]);
  return ref;
}
