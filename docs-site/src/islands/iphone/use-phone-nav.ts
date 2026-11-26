import { useCallback, useRef, useState } from "react";

/** A screen in the demo's navigation stack. */
export type Route =
  | { screen: "hosts" }
  | { screen: "host"; host: string }
  | { screen: "cpu"; host: string };

export interface StackEntry {
  key: number;
  route: Route;
}

/**
 * A UINavigationController-style stack: `push` slides a screen in over the
 * current one, `pop` slides the top one out. The popped entry stays in
 * `leaving` until its exit transition ends (`settle`), so it keeps its DOM
 * node, and any transform an interactive swipe left on it, while it goes.
 */
export function usePhoneNav() {
  const nextKey = useRef(1);
  const [stack, setStack] = useState<StackEntry[]>([
    { key: 0, route: { screen: "hosts" } },
  ]);
  const [leaving, setLeaving] = useState<StackEntry | null>(null);
  const current = useRef(stack);
  current.current = stack;

  const push = useCallback((route: Route) => {
    setLeaving(null);
    setStack((s) => [...s, { key: nextKey.current++, route }]);
  }, []);

  const pop = useCallback(() => {
    const s = current.current;
    const top = s.at(-1);
    if (s.length < 2 || !top) return;
    setLeaving(top);
    setStack(s.slice(0, -1));
  }, []);

  const settle = useCallback((key: number) => {
    setLeaving((l) => (l?.key === key ? null : l));
  }, []);

  return { stack, leaving, push, pop, settle };
}
