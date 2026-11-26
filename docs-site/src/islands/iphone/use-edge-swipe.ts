import { type RefObject, useEffect, useRef } from "react";

/** A drag that starts this close to the left edge, in points, goes back. */
const EDGE = 28;
/** Release past this share of the width, or faster than this, completes. */
const COMMIT_SHARE = 0.35;
const COMMIT_SPEED = 0.5; // points per ms

/**
 * The interactive pop gesture: drag from the screen's left edge and the top
 * screen follows the finger while the one below slides out from under it.
 * Release far or fast enough to go back; otherwise both spring back.
 *
 * The layers move by inline transforms written straight to the DOM while
 * dragging; on release the inline styles are cleared in the same frame the
 * navigation state changes, so each layer's CSS transition carries it from
 * where the finger left it.
 */
export function useEdgeSwipe(
  container: RefObject<HTMLElement | null>,
  enabled: boolean,
  onBack: () => void
) {
  const latest = useRef({ enabled, onBack });
  latest.current = { enabled, onBack };

  useEffect(() => {
    const root = container.current;
    if (!root) return;
    let drag: {
      id: number;
      x0: number;
      scale: number;
      width: number;
      top: HTMLElement;
      below: HTMLElement | null;
      dx: number;
      t: number;
      v: number;
    } | null = null;

    const layers = () =>
      Array.from(root.querySelectorAll<HTMLElement>(":scope > [data-layer]"));
    const place = (el: HTMLElement | null, transform: string) => {
      if (!el) return;
      el.style.transition = "none";
      el.style.transform = transform;
    };
    const release = (el: HTMLElement | null) => {
      if (!el) return;
      el.style.transition = "";
      el.style.transform = "";
    };

    const onDown = (event: PointerEvent) => {
      if (!latest.current.enabled || event.button !== 0) return;
      const rect = root.getBoundingClientRect();
      const scale = rect.width / root.offsetWidth || 1;
      if ((event.clientX - rect.left) / scale > EDGE) return;
      const all = layers().filter((l) => l.dataset.state !== "leaving");
      const top = all.at(-1);
      if (!top) return;
      drag = {
        id: event.pointerId,
        x0: event.clientX,
        scale,
        width: root.offsetWidth,
        top,
        below: all.at(-2) ?? null,
        dx: 0,
        t: event.timeStamp,
        v: 0,
      };
    };

    const onMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = Math.max(0, (event.clientX - drag.x0) / drag.scale);
      // Capture only once it is a drag, so a tap still clicks the back
      // button under it.
      if (dx > 4 && !root.hasPointerCapture?.(event.pointerId)) {
        root.setPointerCapture?.(event.pointerId);
      }
      const dt = Math.max(1, event.timeStamp - drag.t);
      drag.v = (dx - drag.dx) / dt;
      drag.dx = dx;
      drag.t = event.timeStamp;
      const share = Math.min(1, dx / drag.width);
      place(drag.top, `translateX(${dx}px)`);
      place(drag.below, `translateX(${-30 * (1 - share)}%)`);
    };

    const onUp = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      const { top, below, dx, v, width } = drag;
      drag = null;
      // Let the transitions run from the dragged position.
      top.style.transition = "";
      if (below) below.style.transition = "";
      if (dx > width * COMMIT_SHARE || v > COMMIT_SPEED) {
        latest.current.onBack();
        requestAnimationFrame(() => {
          top.style.transform = "";
          release(below);
        });
      } else {
        release(top);
        release(below);
      }
    };

    root.addEventListener("pointerdown", onDown);
    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerup", onUp);
    root.addEventListener("pointercancel", onUp);
    return () => {
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerup", onUp);
      root.removeEventListener("pointercancel", onUp);
    };
  }, [container]);
}
