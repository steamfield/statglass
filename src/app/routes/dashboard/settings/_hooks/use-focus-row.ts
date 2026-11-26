/**
 * Brings the row a Settings link names (`?focus=<row id>`) into view once it
 * renders, highlights it briefly with `data-flash`, and calls `onDone` so the
 * route can drop the param. Rows can mount after the page does (panels wait
 * on queries), so the hook keeps looking for a while before giving up.
 */
import { useCallback, useEffect, useRef } from "react";

/** How long to keep looking for a row that hasn't rendered yet. */
const FIND_DEADLINE_MS = 3000;

/**
 * How long a found row keeps `data-flash` when no fade runs (Reduce Motion,
 * Performance mode), so the held tint is seen. With motion, the fade's own
 * `animationend` (over `--motion-flash`) removes it.
 */
const FLASH_HOLD_MS = 1400;

/**
 * The element carrying `data-settings-row="<id>"` under `root`, or null when
 * none has rendered. Compares attributes rather than building a selector, so
 * an id from the URL never needs escaping.
 */
export function findSettingsRow(
  root: ParentNode,
  id: string
): HTMLElement | null {
  for (const el of root.querySelectorAll<HTMLElement>("[data-settings-row]")) {
    if (el.dataset.settingsRow === id) return el;
  }
  return null;
}

/**
 * Scrolls to the Settings row named by `focus` and flashes it, calling
 * `onDone` as soon as it is found, or at the 3 s search deadline.
 * The flash runs for its full length even after `focus` clears.
 */
export function useFocusRow(focus: string | null, onDone: () => void): void {
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const flashFor = useFlash();

  useEffect(() => {
    if (!focus) return;
    const stop = () => {
      observer.disconnect();
      window.clearTimeout(deadlineTimer);
    };
    const finish = () => {
      stop();
      onDoneRef.current();
    };
    const tryFocus = () => {
      const row = findSettingsRow(document.body, focus);
      if (!row) return false;
      row.scrollIntoView({ block: "center" });
      flashFor(row);
      finish();
      return true;
    };
    const observer = new MutationObserver(() => {
      tryFocus();
    });
    const deadlineTimer = window.setTimeout(finish, FIND_DEADLINE_MS);
    if (tryFocus()) return;
    observer.observe(document.body, { childList: true, subtree: true });
    return stop;
  }, [focus, flashFor]);
}

/**
 * A stable function that sets `data-flash` on one element until its fade ends
 * (or for `FLASH_HOLD_MS` when none runs),
 * moving it off any element still flashing. The timer outlives focus
 * changes and is cleared on unmount.
 */
function useFlash(): (el: HTMLElement) => void {
  const flashing = useRef<{ el: HTMLElement; timer: number } | null>(null);
  const stop = useCallback(() => {
    if (!flashing.current) return;
    window.clearTimeout(flashing.current.timer);
    flashing.current.el.removeAttribute("data-flash");
    flashing.current = null;
  }, []);
  const start = useCallback(
    (el: HTMLElement) => {
      stop();
      el.setAttribute("data-flash", "");
      const onEnd = (event: AnimationEvent) => {
        // Rows hold their own animations; only the flash's own end counts.
        if (event.target !== el || event.animationName !== "settings-row-flash")
          return;
        el.removeEventListener("animationend", onEnd);
        if (flashing.current?.el === el) stop();
      };
      el.addEventListener("animationend", onEnd);
      flashing.current = { el, timer: window.setTimeout(stop, FLASH_HOLD_MS) };
    },
    [stop]
  );
  useEffect(() => stop, [stop]);
  return start;
}
