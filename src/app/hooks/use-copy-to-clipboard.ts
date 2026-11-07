import { useCallback, useEffect, useRef, useState } from "react";

/** How long "Copied" (or "Couldn't copy") stays up after a copy. */
export const COPIED_MS = 1500;

export type CopyStatus = "idle" | "copied" | "failed";

/**
 * Write text to the clipboard and say how it went: `status` is "copied" or
 * "failed" for {@link COPIED_MS}, then "idle" again; `text` is what was last
 * copied while the status is up. `copy` resolves true when the clipboard
 * took the text, so a caller can toast instead of reading `status`. A
 * refusal is logged with `context`.
 */
export function useCopyToClipboard(context: string) {
  const [state, setState] = useState<{
    status: CopyStatus;
    text: string | null;
  }>({ status: "idle", text: null });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A copy can settle after unmount; it then leaves no state or timer behind.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      let status: CopyStatus;
      try {
        await navigator.clipboard.writeText(text);
        status = "copied";
      } catch (err) {
        console.error(`[${context}] copy failed`, err);
        status = "failed";
      }
      if (!mounted.current) return status === "copied";
      setState({ status, text });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(
        () => setState({ status: "idle", text: null }),
        COPIED_MS
      );
      return status === "copied";
    },
    [context]
  );
  return {
    status: state.status,
    text: state.status === "copied" ? state.text : null,
    copy,
  };
}
