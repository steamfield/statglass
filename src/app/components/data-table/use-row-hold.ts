import { type FocusEvent, useCallback, useMemo, useState } from "react";

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
 * leaves. Spread `holdProps` on the element that wraps the rows; call
 * `release` when that element unmounts under a still-mounted owner, since
 * it gets no leave or blur then.
 */
export function useRowHold({ pointer = true, when = false }: RowHoldOptions) {
  const [hovered, setHovered] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const holdProps = useMemo(
    () => ({
      onPointerEnter: () => setHovered(true),
      onPointerLeave: () => setHovered(false),
      onFocusCapture: (event: FocusEvent<HTMLElement>) =>
        setKeyboard(event.target.matches(":focus-visible")),
      onBlurCapture: (event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setKeyboard(false);
      },
    }),
    []
  );
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
