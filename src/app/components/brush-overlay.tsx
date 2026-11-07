import {
  BRUSH_STEP_MS,
  bucketAt,
  clampRange,
  extendRange,
  rangeFractions,
  snapRange,
  type TimeRange,
  timeAt,
} from "@core/brush";
import { cssPercent, formatClockSeconds } from "@core/format";
import { floorTo } from "@core/time-grid";
import {
  type PointerEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { PLOT_INSET } from "~/components/charts/layout";
import {
  type KeyBounds,
  sliderValues,
  useBrushGesture,
} from "~/hooks/use-brush-gesture";
import { useBrush, useBrushStore } from "~/stores/brush-store";

/**
 * The chart and the views that read its selection mark themselves with this
 * attribute; a press inside one never clears the selection from outside.
 */
export const BRUSH_SCOPE_ATTR = "data-brush-scope";

/** Spread on each element that reads the selection: `<Card {...brushScopeProps}>`. */
export const brushScopeProps = { [BRUSH_SCOPE_ATTR]: "" } as const;

/** Presses on these act on their own, so they never clear the selection. */
const INTERACTIVE = [
  "button, a, input, select, textarea, label, summary, [contenteditable=true]",
  "[role=button], [role=link], [role=tab], [role=radio], [role=checkbox], [role=switch], [role=slider]",
  "[role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=option], [role=listbox], [role=dialog], [role=alertdialog]",
].join(", ");

/**
 * Clears the selection the conventional ways while there is one: Esc
 * anywhere on the page (not while typing in a field or with a dialog open),
 * and a press on empty space outside the chart and its views.
 */
export function useDismissOutside(clear: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest("input, textarea, select, [contenteditable=true]")) return;
      if (document.querySelector("[role=dialog], [role=alertdialog]")) return;
      clear();
    };
    const onDown = (e: globalThis.PointerEvent) => {
      if (e.button !== 0) return;
      // A dialog's backdrop is a sibling of its content, so the target check
      // below would treat a press on it as empty space.
      if (document.querySelector("[role=dialog], [role=alertdialog]")) return;
      const t = e.target instanceof Element ? e.target : null;
      if (!t || t.closest(`[${BRUSH_SCOPE_ATTR}]`) || t.closest(INTERACTIVE)) {
        return;
      }
      clear();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [clear, active]);
}

export interface BrushOverlayProps {
  /** Start of the chart's first bar. */
  firstMs: number;
  /** Time the chart spans, first bar's start to last bar's end. */
  spanMs: number;
  /** Height of the bars, px. */
  height: number;
  /**
   * End of the selectable time: the newest elapsed 10 s edge. The last bar
   * reaches into time that has not happened yet; that part cannot be
   * selected or focused. Defaults to the chart's end.
   */
  selectableToMs?: number | undefined;
  /** Distance from the positioned parent's left edge to the plot, px. */
  inset?: number;
  gapExplanationAt?: (time: number) => string | null;
  /** Optional metric readout; selection and keyboard behavior stay shared. */
  onHoverTime?: (time: number | null, fractionY: number) => void;
}

/** The 10 s buckets focus can sit on: the elapsed part of the chart. */
const focusBounds = (lo: number, hi: number): KeyBounds => ({
  first: floorTo(lo, BRUSH_STEP_MS),
  last: floorTo(hi - 1, BRUSH_STEP_MS),
  step: BRUSH_STEP_MS,
});
const within = (t: number, b: KeyBounds) =>
  Math.min(b.last, Math.max(b.first, t));
/** Where focus lands: the selection's last bucket, else the newest one. */
const restingFocus = (r: TimeRange | null, b: KeyBounds) =>
  within(r ? r.toMs - BRUSH_STEP_MS : b.last, b);

/**
 * The selection layer over a brushable live chart (D-089): a
 * crosshair and a 10 s hover column, drag to select, click for the 10 s
 * bucket under the pointer. A selection clears like a d3 brush's: a plain
 * click on the chart, Esc anywhere on the page, or a press on empty space
 * outside the chart and its views (D-093). Focusable: arrows move a 10 s
 * focus, Enter selects it, Shift+arrows extend the selection.
 *
 * The hover column is moved through its ref, never through state, so a
 * pointer passing over the chart re-renders nothing; only a drag and a
 * change of selection do.
 *
 * Exposed as a slider over the selectable 10 s buckets: its value is the
 * focused bucket's position, its text that bucket's times and then the
 * selection, and its description the keys.
 */
export function BrushOverlay({
  firstMs,
  spanMs,
  height,
  selectableToMs,
  inset = PLOT_INSET,
  onHoverTime,
  gapExplanationAt,
}: BrushOverlayProps) {
  const store = useBrushStore();
  const view = useBrush((s) => s.draft ?? s.range);
  const range = useBrush((s) => s.range);
  const hoverRef = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const toMs = Math.min(firstMs + spanMs, selectableToMs ?? firstMs + spanMs);
  const geo = useRef({ firstMs, spanMs, toMs });
  useLayoutEffect(() => {
    geo.current = { firstMs, spanMs, toMs };
  }, [firstMs, spanMs, toMs]);
  const anchor = useRef<number | null>(null);
  const [focusMs, setFocusMs] = useState<number | null>(null);
  useDismissOutside(store.getState().clear, range !== null);

  const clamp = (r: TimeRange) =>
    clampRange(r, geo.current.firstMs, geo.current.toMs);
  const timeOf = (e: PointerEvent<HTMLElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const f = box.width > 0 ? (e.clientX - box.left) / box.width : 0;
    const g = geo.current;
    // The right edge belongs to the last selectable bucket, not the time
    // after it.
    return Math.min(timeAt(f, g.firstMs, g.spanMs), g.toMs - 1);
  };
  const keyBounds = () => focusBounds(geo.current.firstMs, geo.current.toMs);
  const showHover = (tMs: number | null) => {
    const el = hoverRef.current;
    if (!el) return;
    const g = geo.current;
    const f =
      tMs === null ? null : rangeFractions(bucketAt(tMs), g.firstMs, g.spanMs);
    el.hidden = !f;
    if (!f) return;
    el.style.left = cssPercent(f.left);
    el.style.width = cssPercent(f.width);
  };
  const focusOn = (t: number) => {
    setFocusMs(t);
    onHoverTime?.(t, 0);
  };

  const gesture = useBrushGesture({
    timeAt: timeOf,
    onPointer: (t, e) => {
      e.currentTarget.title = gapExplanationAt?.(t) ?? "";
      const rect = e.currentTarget.getBoundingClientRect();
      onHoverTime?.(t, (e.clientY - rect.top) / rect.height);
      showHover(t);
    },
    onDrag: (a, t) => store.getState().setDraft(clamp(snapRange(a, t))),
    onRelease: (a, t, dragged) => {
      const s = store.getState();
      if (!dragged && s.range !== null) {
        // A click with a selection up dismisses it; a drag replaces it.
        s.clear();
        anchor.current = null;
        return;
      }
      const picked = dragged ? clamp(snapRange(a, t ?? a)) : clamp(bucketAt(a));
      s.select(picked);
      anchor.current = picked.fromMs;
    },
    onCancel: () => store.getState().setDraft(null),
    keyBounds,
    position: () => within(focusMs ?? keyBounds().last, keyBounds()),
    anchorFor: (at, dir) => {
      // Extend from the end of the selection away from the focus, or start
      // one at the bucket the focus was on.
      if (anchor.current === null) {
        const r = store.getState().range;
        anchor.current =
          r && at >= r.fromMs && at < r.toMs
            ? dir > 0
              ? r.fromMs
              : r.toMs - BRUSH_STEP_MS
            : at;
      }
      return anchor.current;
    },
    onMove: (to) => {
      focusOn(to);
      anchor.current = null;
    },
    onExtend: (a, to) => {
      focusOn(to);
      store.getState().select(extendRange(a, to));
    },
    onEnter: (at) => {
      store.getState().select(bucketAt(at));
      anchor.current = at;
      return true;
    },
    onEscape: (e) => {
      onHoverTime?.(null, 0);
      setFocusMs(null);
      // A drag in progress ends here: its next move or release does nothing.
      gesture.reset();
      const s = store.getState();
      if (s.range === null && s.draft === null) return;
      e.preventDefault();
      s.clear();
      anchor.current = null;
    },
  });

  const onFocus = () => {
    if (focusMs !== null) return;
    // Pointer-down precedes focus. Keep its hovered bucket; only keyboard
    // entry should move the tooltip to the selection/newest observation.
    const pressed = gesture.pressedAt();
    if (pressed !== null) setFocusMs(floorTo(pressed, BRUSH_STEP_MS));
    else focusOn(restingFocus(store.getState().range, keyBounds()));
  };

  const band = view ? rangeFractions(view, firstMs, spanMs) : null;
  const focus =
    focusMs === null
      ? null
      : rangeFractions(bucketAt(focusMs), firstMs, spanMs);
  // The bucket the slider is on: focused, or where focus will land.
  const bounds = focusBounds(firstMs, toMs);
  const at =
    focusMs === null ? restingFocus(range, bounds) : within(focusMs, bounds);
  const slider = sliderValues(at, bounds);
  const span = (r: TimeRange) =>
    `${formatClockSeconds(r.fromMs)} to ${formatClockSeconds(r.toMs)}`;
  const valueText = `${span(bucketAt(at))}, ${
    view ? `selected ${span(view)}` : "no selection"
  }`;

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Select a time range"
      aria-describedby={hintId}
      aria-valuemin={slider.min}
      aria-valuemax={slider.max}
      aria-valuenow={slider.now}
      aria-valuetext={[valueText, gapExplanationAt?.(at)]
        .filter(Boolean)
        .join(". ")}
      title={gapExplanationAt?.(at) ?? undefined}
      data-testid="brush"
      className="group absolute top-0 right-0 cursor-crosshair touch-none select-none rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={{ height, left: inset }}
      {...gesture.handlers}
      onPointerLeave={() => {
        showHover(null);
        onHoverTime?.(null, 0);
      }}
      onFocus={onFocus}
      onBlur={() => {
        setFocusMs(null);
        onHoverTime?.(null, 0);
      }}
    >
      <span id={hintId} className="sr-only">
        Arrow keys move, Enter selects, Shift+arrows extend, Escape clears
      </span>
      <div
        ref={hoverRef}
        hidden
        data-testid="brush-hover"
        className="pointer-events-none absolute inset-y-0 bg-foreground/4"
      />
      {band && (
        <div
          data-testid="brush-band"
          className="pointer-events-none absolute inset-y-0 border-foreground/35 border-x bg-foreground/5"
          style={{ left: cssPercent(band.left), width: cssPercent(band.width) }}
        />
      )}
      {focus && (
        <div
          data-testid="brush-focus"
          className="pointer-events-none absolute inset-y-0 hidden bg-foreground/6 outline outline-1 outline-ring group-focus-visible:block"
          style={{
            left: cssPercent(focus.left),
            width: cssPercent(focus.width),
          }}
        />
      )}
    </div>
  );
}
