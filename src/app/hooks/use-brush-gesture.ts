import { floorTo } from "@core/time-grid";
import { type KeyboardEvent, type PointerEvent, useRef } from "react";

/** Pointer travel, px, below which a press is a click rather than a drag. */
export const DRAG_SLOP_PX = 3;

/** The keyboard cursor's range: bucket starts from `first` to `last`, `step` apart. */
export interface KeyBounds {
  first: number;
  last: number;
  step: number;
}

const KEY_STEP: Record<string, -1 | 1> = { ArrowLeft: -1, ArrowRight: 1 };

/**
 * Where a key moves a cursor at `at`: one step for the arrows, the ends for
 * Home and End, snapped down to the step and kept inside the bounds. Null
 * for any other key.
 */
export function keyTarget(
  key: string,
  at: number,
  { first, last, step }: KeyBounds
): number | null {
  const dir = KEY_STEP[key];
  const raw =
    dir !== undefined
      ? at + dir * step
      : key === "Home"
        ? first
        : key === "End"
          ? last
          : null;
  if (raw === null) return null;
  return Math.min(last, Math.max(first, floorTo(raw, step)));
}

/**
 * ARIA slider values for a cursor over buckets: positions counted from the
 * first bucket, not epoch milliseconds.
 */
export function sliderValues(
  at: number,
  { first, last, step }: KeyBounds
): { min: number; max: number; now: number } {
  return {
    min: 0,
    max: Math.max(0, Math.round((last - first) / step)),
    now: Math.round((at - first) / step),
  };
}

export interface BrushGestureOptions {
  /** Time under the pointer, or null when the plot has no size. */
  timeAt: (e: PointerEvent<HTMLElement>) => number | null;
  /** Whether a press may start a drag now (default yes). */
  canDrag?: () => boolean;
  /** A press is starting, before its time is read. */
  onPress?: () => void;
  /** A press began at `anchor`. */
  onDragStart?: (anchor: number) => void;
  /** Every pointer move over the plot, dragging or not. */
  onPointer?: (
    t: number,
    e: PointerEvent<HTMLElement>,
    dragging: boolean
  ) => void;
  /** The drag moved past the slop: draw `anchor` to `t`. */
  onDrag: (anchor: number, t: number) => void;
  /** The press ended; `dragged` is false for a click. */
  onRelease: (anchor: number, t: number | null, dragged: boolean) => void;
  /** The drag was cancelled or lost its pointer capture. */
  onCancel: () => void;
  /** The keyboard cursor's range, read at each key press. */
  keyBounds: () => KeyBounds;
  /** Where the keyboard cursor is now. */
  position: () => number;
  /** Whether a move key acts now (default yes). */
  canMove?: () => boolean;
  /** Whether Shift extends a range (default yes). */
  canExtend?: () => boolean;
  /** Shift+move is about to extend, before the bounds are read. */
  onExtendStart?: () => void;
  /** The fixed end of a Shift+move range, given the cursor and direction. */
  anchorFor: (at: number, dir: -1 | 0 | 1) => number;
  /** A plain move key moved the cursor. */
  onMove: (to: number) => void;
  /** A Shift+move key extended the range from `anchor` to `to`. */
  onExtend: (anchor: number, to: number) => void;
  /** Enter or Space at `at`; return true when handled. */
  onEnter: (at: number) => boolean;
  onEscape: (e: KeyboardEvent<HTMLElement>) => void;
}

type Drag = { pointer: number; x: number; anchor: number; moved: boolean };

/**
 * The gesture of a range selection over a plot, shared by `BrushOverlay` and
 * the Timeline: a pointer-captured drag with a click slop, and a keyboard
 * cursor (arrows, Home/End, Shift to extend, Enter, Escape). What a
 * selection means stays with the owner, through the callbacks: the brush
 * scopes attribution, the Timeline zooms.
 *
 * The drag lives in a ref, so a pointer move re-renders nothing unless a
 * callback sets state.
 */
export function useBrushGesture(o: BrushGestureOptions) {
  const drag = useRef<Drag | null>(null);
  const cancel = () => {
    drag.current = null;
    o.onCancel();
  };
  return {
    /** The time a press in progress started at, if any. */
    pressedAt: () => drag.current?.anchor ?? null,
    /** Forget a press in progress; its release then does nothing. */
    reset: () => {
      drag.current = null;
    },
    handlers: {
      onPointerDown: (e: PointerEvent<HTMLElement>) => {
        if (e.button !== 0 || o.canDrag?.() === false) return;
        o.onPress?.();
        const anchor = o.timeAt(e);
        if (anchor === null) return;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = {
          pointer: e.pointerId,
          x: e.clientX,
          anchor,
          moved: false,
        };
        o.onDragStart?.(anchor);
      },
      onPointerMove: (e: PointerEvent<HTMLElement>) => {
        const t = o.timeAt(e);
        if (t === null) return;
        const d = drag.current;
        o.onPointer?.(t, e, d !== null);
        if (!d) return;
        if (!d.moved && Math.abs(e.clientX - d.x) < DRAG_SLOP_PX) return;
        d.moved = true;
        o.onDrag(d.anchor, t);
      },
      onPointerUp: (e: PointerEvent<HTMLElement>) => {
        const d = drag.current;
        if (!d || d.pointer !== e.pointerId) return;
        drag.current = null;
        const dragged = d.moved || Math.abs(e.clientX - d.x) >= DRAG_SLOP_PX;
        o.onRelease(d.anchor, o.timeAt(e), dragged);
        if (e.currentTarget.hasPointerCapture?.(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
      },
      onPointerCancel: cancel,
      onLostPointerCapture: () => {
        if (drag.current) cancel();
      },
      onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
        if (e.key === "Escape") {
          o.onEscape(e);
          return;
        }
        if (e.key === "Enter" || e.key === " ") {
          if (o.onEnter(o.position())) e.preventDefault();
          return;
        }
        if (o.canMove?.() !== false) moveKey(e, o);
      },
    },
  };
}

/** A move key: the cursor moves, or with Shift the range extends. */
function moveKey(e: KeyboardEvent<HTMLElement>, o: BrushGestureOptions) {
  const extend = e.shiftKey && o.canExtend?.() !== false;
  if (extend) o.onExtendStart?.();
  const at = o.position();
  const to = keyTarget(e.key, at, o.keyBounds());
  if (to === null) return;
  e.preventDefault();
  if (extend) o.onExtend(o.anchorFor(at, KEY_STEP[e.key] ?? 0), to);
  else o.onMove(to);
}
