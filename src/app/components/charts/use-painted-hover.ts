import { type RefObject, useLayoutEffect, useRef } from "react";

/**
 * The imperative hover readout the chart tooltips share: it listens on the
 * tooltip's parent, maps the pointer's x across `plotRef` (or the parent
 * itself, without one) to a slot with `slotAt`, and calls `paint` when the
 * slot changes and after every render, so a tick refreshes the values under
 * a resting cursor. A pointer passing over the chart re-renders nothing.
 * Returns the tooltip's ref.
 */
export function usePaintedHover<P>(
  props: P,
  slotAt: (fraction: number, props: P) => number | null,
  paint: (tip: HTMLElement, props: P, slot: number | null) => void,
  plotRef?: RefObject<HTMLElement | null>
): RefObject<HTMLDivElement | null> {
  const latest = useRef({ props, slotAt, paint, plotRef });
  const slot = useRef<number | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    latest.current = { props, slotAt, paint, plotRef };
    if (tipRef.current) paint(tipRef.current, props, slot.current);
  });

  useLayoutEffect(() => {
    const tip = tipRef.current;
    const host = tip?.parentElement;
    if (!tip || !host) return;
    const move = (e: globalThis.PointerEvent) => {
      const l = latest.current;
      const box = (
        l.plotRef ? l.plotRef.current : host
      )?.getBoundingClientRect();
      const next =
        box && box.width > 0
          ? l.slotAt((e.clientX - box.left) / box.width, l.props)
          : null;
      if (next === slot.current) return;
      slot.current = next;
      l.paint(tip, l.props, next);
    };
    const leave = () => {
      slot.current = null;
      latest.current.paint(tip, latest.current.props, null);
    };
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerleave", leave);
    return () => {
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", leave);
    };
  }, []);

  return tipRef;
}
