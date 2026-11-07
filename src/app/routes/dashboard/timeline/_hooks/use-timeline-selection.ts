import type { TimeRange } from "@core/brush";
import { floorTo } from "@core/time-grid";
import { type PointerEvent, useEffect, useRef, useState } from "react";
import { sliderValues, useBrushGesture } from "~/hooks/use-brush-gesture";
import { selectedRange } from "../_lib/selection";

interface SelectionOptions {
  rangeKey: string;
  fromMs: number;
  toMs: number;
  bucketMs: number;
  width: number;
  nowMs: number;
  retainedFromMs: number;
  loading: boolean;
  onSelectRange?: ((range: TimeRange) => void) | undefined;
}
type Geometry = {
  from: number;
  to: number;
  bucket: number;
  left: number;
  width: number;
};
type Selection = { anchor: number; current: number } | null;

/**
 * A press zooms only when it ends 4 px or more from where it began, checked
 * at release too, so a jittery click inspects rather than navigates.
 */
const CLICK = { slop: 4, latch: false } as const;

/**
 * The Timeline's cursor and range selection over the shared brush gesture:
 * a drag or Shift+arrows preview a range on the displayed buckets, and a
 * release or Enter zooms to it through `onSelectRange`. The plot geometry
 * freezes while a selection is in progress, so a Live tail advancing under
 * it does not move its dates.
 */
export function useTimelineSelection({
  fromMs,
  toMs,
  rangeKey,
  bucketMs,
  width,
  nowMs,
  retainedFromMs,
  loading,
  onSelectRange,
}: SelectionOptions) {
  const sliderRef = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const geometry = useRef<Geometry | null>(null);
  const freeze = () => {
    geometry.current ??= plotGeometry(
      sliderRef.current,
      fromMs,
      toMs,
      bucketMs,
      width
    );
  };
  const focusAfterRange = useRef(false);
  const lastBucket = Math.max(fromMs, toMs - bucketMs);
  const moveCursor = (t: number) =>
    setCursor(clampCursor(t, geometry.current, fromMs, lastBucket));
  const cancelSelection = () => {
    geometry.current = null;
    gesture.reset();
    setSelection(null);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: committed range identity resets; Live tail bounds do not
  useEffect(() => {
    cancelSelection();
    setCursor(null);
    if (focusAfterRange.current) {
      focusAfterRange.current = false;
      sliderRef.current?.focus({ preventScroll: true });
    }
  }, [rangeKey]);
  const snap = (a: number, b: number) =>
    selectedRange(
      a,
      b,
      geometry.current?.bucket ?? bucketMs,
      nowMs,
      retainedFromMs
    );
  const commitSelection = (a: number, b: number) => {
    const next = snap(a, b);
    cancelSelection();
    if (next) onSelectRange?.(next);
  };
  const keyBounds = () => {
    const { from, to, bucket } = geometry.current ?? {
      from: fromMs,
      to: toMs,
      bucket: bucketMs,
    };
    return { first: from, last: Math.max(from, to - bucket), step: bucket };
  };
  const gesture = useBrushGesture({
    ...CLICK,
    timeAt: (e) => pointerTime(e, fromMs, toMs, geometry.current),
    canDrag: () => Boolean(onSelectRange) && width > 0 && !loading,
    onPress: freeze,
    onDragStart: () => setSelection(null),
    onPointer: (t, _e, dragging) => {
      if (!dragging) moveCursor(floorTo(t, bucketMs));
    },
    onDrag: (anchor, current) => setSelection({ anchor, current }),
    onRelease: (anchor, current, dragged) => {
      if (current !== null && dragged) commitSelection(anchor, current);
      else {
        cancelSelection();
        if (current !== null) moveCursor(floorTo(current, bucketMs));
      }
    },
    onCancel: cancelSelection,
    keyBounds,
    position: () => cursor ?? keyBounds().last,
    canMove: () => !loading || selection !== null,
    canExtend: () => Boolean(onSelectRange),
    onExtendStart: freeze,
    anchorFor: (at) => selection?.anchor ?? at,
    onMove: (to) => {
      geometry.current = null;
      setSelection(null);
      moveCursor(to);
    },
    onExtend: (anchor, to) => {
      setSelection({ anchor, current: to });
      moveCursor(to);
    },
    onEnter: () => {
      if (!selection) return false;
      commitSelection(selection.anchor, selection.current);
      return true;
    },
    onEscape: (e) => {
      e.preventDefault();
      cancelSelection();
    },
  });
  return {
    sliderRef,
    cursor,
    selecting: selection !== null,
    focusAfterRange,
    preview: selection ? snap(selection.anchor, selection.current) : null,
    /**
     * ARIA slider positions, counted in buckets as on the brush, over the
     * same (possibly frozen) bounds the cursor is clamped to.
     */
    slider: sliderValues(cursor ?? keyBounds().last, keyBounds()),
    selectEvent: (tMs: number) => {
      moveCursor(floorTo(tMs, bucketMs));
      sliderRef.current?.focus();
    },
    sliderProps: {
      ...gesture.handlers,
      onPointerLeave: () => {
        if (gesture.pressedAt() === null) setCursor(null);
      },
      onFocus: () => setCursor((c) => c ?? lastBucket),
      onBlur: () => {
        setCursor(null);
        cancelSelection();
      },
    },
  };
}

function pointerTime(
  e: PointerEvent<HTMLElement>,
  fromMs: number,
  toMs: number,
  frozen: { from: number; to: number; left: number; width: number } | null
) {
  const rect = frozen ?? e.currentTarget.getBoundingClientRect();
  const from = frozen?.from ?? fromMs;
  const to = frozen?.to ?? toMs;
  return rect.width > 0
    ? from +
        Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) *
          (to - from)
    : null;
}

function clampCursor(
  t: number,
  geometry: Geometry | null,
  from: number,
  last: number
) {
  return Math.min(
    geometry ? Math.max(geometry.from, geometry.to - geometry.bucket) : last,
    Math.max(geometry?.from ?? from, t)
  );
}

function plotGeometry(
  element: HTMLElement | null,
  from: number,
  to: number,
  bucket: number,
  width: number
): Geometry {
  const rect = element?.getBoundingClientRect();
  return {
    from,
    to,
    bucket,
    left: rect?.left ?? 0,
    width: rect?.width ?? width,
  };
}
