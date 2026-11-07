import {
  type FocusEvent,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export interface RowHoldOptions {
  /** Hover holds the order too. On by default; the process table opts in. */
  pointer?: boolean;
  /** The owner's own reasons to hold: an open menu, a pending action. */
  when?: boolean;
}

/**
 * Whether a live list keeps its row order: while the pointer is over it,
 * while keyboard focus (`:focus-visible`) is inside it, or while the owner
 * says so. A mouse click that focuses a row holds only until the pointer
 * leaves. Spread `holdProps` on the element that wraps the rows.
 *
 * A focused row that unmounts (the process exits, a virtual row scrolls out,
 * a group collapses) fires no blur in WebKit, so the keyboard hold also ends
 * on the owner's next render once focus is no longer inside the surface.
 * Call `release` when the surface itself unmounts under a still-mounted
 * owner, since it gets no pointer leave then.
 */
export function useRowHold({ pointer = true, when = false }: RowHoldOptions) {
  const [hovered, setHovered] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  // The element `holdProps` is spread on, taken from its own events so the
  // owner's ref on that element stays the owner's.
  const surface = useRef<HTMLElement | null>(null);
  const holdProps = useMemo(
    () => ({
      onPointerEnter: () => setHovered(true),
      onPointerLeave: () => {
        setHovered(false);
        if (!surface.current?.contains(document.activeElement))
          setKeyboard(false);
      },
      onFocusCapture: (event: FocusEvent<HTMLElement>) => {
        surface.current = event.currentTarget;
        setKeyboard(event.target.matches(":focus-visible"));
      },
      onBlurCapture: (event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setKeyboard(false);
      },
    }),
    []
  );
  useLayoutEffect(() => {
    if (keyboard && !surface.current?.contains(document.activeElement))
      setKeyboard(false);
  });
  const release = useCallback(() => {
    setHovered(false);
    setKeyboard(false);
  }, []);
  return {
    held: (pointer && hovered) || keyboard || when,
    hovered,
    holdProps,
    release,
  };
}
