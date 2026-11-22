import { useEffect, useState } from "react";

const TICK_MS = 1000;

/**
 * Whole seconds from now until `targetMs` on this Mac's wall clock, for retry
 * countdowns. Ticks once a second only while a target is set and still ahead, so
 * a card with nothing scheduled costs no timer. Never negative; null without a
 * target.
 */
export function useSecondsUntil(targetMs: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (targetMs === null) return;
    const id = setInterval(() => {
      const next = Date.now();
      setNow(next);
      if (next >= targetMs) clearInterval(id);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [targetMs]);
  if (targetMs === null) return null;
  return Math.max(0, Math.ceil((targetMs - now) / TICK_MS));
}
