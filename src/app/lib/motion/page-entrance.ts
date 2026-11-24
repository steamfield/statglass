import { type RefObject, useLayoutEffect, useRef } from "react";
import { motionEase, motionMs } from "./tokens";

/** What the entrance treats as one card: the `Card` widget marks its root. */
const CARD = "[data-card]";
/**
 * A container whose content enters piece by piece even before it has any
 * (`DashboardBody`, where a module page's cards mount once the chart window
 * is known). Anything holding a card or a group is walked, never entered.
 */
const GROUP = "[data-enter-group]";
const WALK = `${CARD}, ${GROUP}`;

/** Last stagger step that still adds delay, so a long page doesn't trickle in. */
const STAGGER_CAP = 8;

/**
 * How long after a page opens late content still counts as part of it: the
 * lazy route chunk and the chart window (D-091) arrive a frame or two after
 * the header. Anything mounted later is a data update and appears in place.
 */
const ENTRANCE_WINDOW_MS = 800;

/** Opacity finishes at 75% of `--motion-page` (300 ms of 400); the rise settles over all of it. */
const CARD_FRAMES: Keyframe[] = [
  { opacity: 0, transform: "translateY(8px) scale(0.985)" },
  { opacity: 1, offset: 0.75 },
  { opacity: 1, transform: "none" },
];
const BLOCK_FRAMES: Keyframe[] = [
  { opacity: 0, transform: "translateY(6px)" },
  { opacity: 1, offset: 0.75 },
  { opacity: 1, transform: "none" },
];

/** Elements that draw something with no child nodes. */
const REPLACED = new Set(["CANVAS", "IMG", "HR", "VIDEO", "svg"]);

/**
 * Adds the entering units in `el` to `out`, in reading order: a card, or an
 * element that holds no card (the page header, a banner, a table) as a whole.
 * An element that holds cards is only a layout row, so its children are
 * walked instead and the row itself never moves; so is a group, and so is the
 * route's root (the host's child), which often mounts before its content. An
 * empty element is skipped so the content that fills it later enters on its own.
 */
function addUnits(el: Element, out: Element[], host: Element): void {
  if (el.childNodes.length === 0 && !REPLACED.has(el.tagName)) return;
  const display = getComputedStyle(el).display;
  if (display === "none") return;
  if (el.matches(CARD)) out.push(el);
  else if (
    display === "contents" ||
    el.parentElement === host ||
    el.matches(GROUP) ||
    el.querySelector(WALK)
  )
    for (const child of el.children) addUnits(child, out, host);
  else out.push(el);
}

/** True when `node` sits inside a unit that already entered (or is one). */
function insideEntered(
  node: Element,
  host: Element,
  entered: WeakSet<Element>
): boolean {
  for (let el: Element | null = node; el && el !== host; el = el.parentElement)
    if (entered.has(el)) return true;
  return false;
}

/** The units that mounted in `records` and haven't entered yet, in order. */
function addedUnits(
  records: readonly MutationRecord[],
  host: Element,
  entered: WeakSet<Element>
): Element[] {
  const units: Element[] = [];
  for (const record of records)
    for (const node of record.addedNodes) {
      if (!(node instanceof Element) || !node.isConnected) continue;
      if (insideEntered(node, host, entered)) continue;
      addUnits(node, units, host);
    }
  return units.filter((unit) => !entered.has(unit));
}

/**
 * Ref for the element hosting a route's `<Outlet />`. Each time `pageKey`
 * changes (and on first mount), the page's cards and blocks fade in and rise
 * into place one after another, in reading order: one Web Animations call
 * per unit with `backwards` fill, so nothing is left on the element and a
 * 1 Hz re-render can't replay it. Units that mount within
 * `ENTRANCE_WINDOW_MS` continue the entrance as their own staggered batch.
 * A 0 ms `--motion-page` (Reduce Motion, Performance mode) skips it all.
 */
export function usePageEntrance<T extends HTMLElement>(
  pageKey: string
): RefObject<T | null> {
  const ref = useRef<T>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: pageKey is the trigger, not an input
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host || typeof host.animate !== "function") return;
    const duration = motionMs("page", host);
    if (duration <= 0) return;
    const step = motionMs("stagger", host);
    const easing = motionEase("enter", host);
    const entered = new WeakSet<Element>();

    const play = (units: readonly Element[]) =>
      units.forEach((unit, i) => {
        entered.add(unit);
        unit.animate(unit.matches(CARD) ? CARD_FRAMES : BLOCK_FRAMES, {
          duration,
          delay: Math.min(i, STAGGER_CAP) * step,
          easing,
          fill: "backwards",
          id: "page-enter",
        });
      });

    const first: Element[] = [];
    for (const child of host.children) addUnits(child, first, host);
    play(first);

    const observer = new MutationObserver((records) =>
      play(addedUnits(records, host, entered))
    );
    observer.observe(host, { childList: true, subtree: true });
    const timer = setTimeout(() => observer.disconnect(), ENTRANCE_WINDOW_MS);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [pageKey]);
  return ref;
}
