import { useCallback, useMemo, useState } from "react";
import type { LegendItem } from "~/widgets/legend";

/** How a line draws under focus. */
export interface SeriesFocusStyle {
  /** Line width, px: 2 for the focused line, 1 otherwise. */
  weight: number;
  /** 1, or 0.3 for the other lines while one is focused. */
  opacity: number;
}

/**
 * The style of line `id` while `active` is focused, for memoized children
 * that take `active` rather than the hook's bound `seriesStyle`.
 */
export function seriesFocusStyle(
  active: string | null,
  id: string
): SeriesFocusStyle {
  return {
    weight: active === id ? 2 : 1,
    opacity: active === null || active === id ? 1 : 0.3,
  };
}

export interface SeriesFocus {
  /** The line in focus: the pinned one, else the hovered one. */
  active: string | null;
  hovered: string | null;
  pinned: string | null;
  setHovered: (id: string | null) => void;
  setPinned: (id: string | null) => void;
  /** Drops the hover and the pin (a click outside, a new range). */
  clear: () => void;
  /** Hover and keyboard focus preview a line; a click pins it or unpins it. */
  legendItemProps: (
    id: string
  ) => Required<Pick<LegendItem, "onFocus" | "onBlur" | "onClick" | "pressed">>;
  seriesStyle: (id: string) => SeriesFocusStyle;
}

/**
 * Chart and legend focus, one precedence everywhere (design-system.md: pinned
 * rows stay stable while hover updates their values): a pinned line stays in
 * focus while the pointer moves over others, and hover shows only while
 * nothing is pinned. `ids`, when given, are the lines drawn now: a focus on
 * a line that is gone counts as none, so the rest don't stay dimmed.
 */
export function useSeriesFocus(ids?: readonly string[]): SeriesFocus {
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const drawn = (id: string | null) =>
    id !== null && (ids === undefined || ids.includes(id)) ? id : null;
  const active = drawn(pinned) ?? drawn(hovered);
  const clear = useCallback(() => {
    setHovered(null);
    setPinned(null);
  }, []);
  return useMemo(
    () => ({
      active,
      hovered,
      pinned,
      setHovered,
      setPinned,
      clear,
      legendItemProps: (id: string) => ({
        pressed: pinned === id,
        onFocus: () => setHovered(id),
        onBlur: () => setHovered(null),
        onClick: () => setPinned((p) => (p === id ? null : id)),
      }),
      seriesStyle: (id: string) => seriesFocusStyle(active, id),
    }),
    [active, hovered, pinned, clear]
  );
}
