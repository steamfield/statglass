import { useEffect, useRef } from "react";

/** The phone's resting pose, degrees: turned toward the copy beside it. */
export const REST = { x: 6, y: 16 } as const;
/** How far the pointer can turn it either way, degrees. */
const POINTER = { x: 7, y: 12 } as const;
/**
 * How far scrolling turns it, degrees, between the stage's centre entering
 * at the bottom of the viewport and leaving at the top: it tips back and
 * swings toward the copy as it rises.
 */
const SCROLL = { x: 14, y: 16 } as const;
/** While the pointer is over the screen the phone squares up to be used. */
const OVER_SCREEN = 0.25;
const EASE = 0.12;

type Angles = { x: number; y: number };

/**
 * Turns the phone with the page's scroll and toward the pointer, by writing
 * `--rx` and `--ry` on `stage` (the phone and its shadow read them) from a
 * rAF loop that stops once settled, so the tilt never re-renders React.
 * Scroll turns it on every device; the pointer only with a mouse, and
 * touching the screen squares it up instead. Reduced motion keeps the
 * resting pose.
 */
export function useTilt<S extends HTMLElement>() {
  const stage = useRef<S>(null);

  useEffect(() => {
    const stageEl = stage.current;
    if (!stageEl) return;
    const motion = matchMedia("(prefers-reduced-motion: no-preference)");
    const fine = matchMedia("(hover: hover) and (pointer: fine)");
    const now: Angles = { ...REST };
    const pointer: Angles = { x: 0, y: 0 };
    const scroll: Angles = { x: 0, y: 0 };
    let squared = false;
    let scrolled = true;
    let frame = 0;

    const target = (): Angles => {
      const k = squared ? OVER_SCREEN : 1;
      return {
        x: (REST.x + pointer.x + scroll.x) * k,
        y: (REST.y + pointer.y + scroll.y) * k,
      };
    };
    const write = () => {
      stageEl.style.setProperty("--rx", `${now.x.toFixed(2)}deg`);
      stageEl.style.setProperty("--ry", `${now.y.toFixed(2)}deg`);
      stageEl.style.setProperty("--ry-n", now.y.toFixed(2));
    };
    // Reads layout once per frame, not once per scroll event.
    const measure = () => {
      if (!scrolled) return;
      scrolled = false;
      const rect = stageEl.getBoundingClientRect();
      const viewport = window.innerHeight || 1;
      // -1 as the stage's centre enters at the bottom, 1 as it leaves at the top.
      const travel = 1 - ((rect.top + rect.height / 2) / viewport) * 2;
      const p = Math.max(-1, Math.min(1, travel));
      scroll.x = p * SCROLL.x;
      scroll.y = -p * SCROLL.y;
    };
    const step = () => {
      measure();
      const t = target();
      now.x += (t.x - now.x) * EASE;
      now.y += (t.y - now.y) * EASE;
      const settled =
        Math.abs(t.x - now.x) < 0.01 && Math.abs(t.y - now.y) < 0.01;
      if (settled) Object.assign(now, t);
      write();
      frame = settled ? 0 : requestAnimationFrame(step);
    };
    const update = () => {
      if (!motion.matches) {
        Object.assign(now, REST);
        write();
      } else if (!frame) frame = requestAnimationFrame(step);
    };

    const onScroll = () => {
      scrolled = true;
      update();
    };
    const onMove = (event: PointerEvent) => {
      squared =
        event.target instanceof Element &&
        event.target.closest("[data-phone-screen]") !== null;
      if (event.pointerType === "mouse" && fine.matches) {
        const rect = stageEl.getBoundingClientRect();
        const px = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        const py = ((event.clientY - rect.top) / rect.height) * 2 - 1;
        pointer.x = -py * POINTER.x;
        pointer.y = px * POINTER.y;
      }
      update();
    };
    const onLeave = () => {
      squared = false;
      pointer.x = 0;
      pointer.y = 0;
      update();
    };

    // Listen to scroll only while the stage is on screen.
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        window.addEventListener("scroll", onScroll, { passive: true });
        onScroll();
      } else window.removeEventListener("scroll", onScroll);
    });
    observer.observe(stageEl);
    write();
    stageEl.addEventListener("pointermove", onMove);
    stageEl.addEventListener("pointerdown", onMove);
    stageEl.addEventListener("pointerleave", onLeave);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("scroll", onScroll);
      stageEl.removeEventListener("pointermove", onMove);
      stageEl.removeEventListener("pointerdown", onMove);
      stageEl.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return stage;
}
