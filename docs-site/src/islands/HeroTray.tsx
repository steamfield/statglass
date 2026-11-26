import {
  type CSSProperties,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import styles from "@/islands/hero-tray.module.css";
import { MenuBarItem } from "@/islands/MenuBarItem";
import { PopoverDemo } from "@/islands/PopoverDemo";

/** The intro plays only where the popover loads on its own and motion is allowed. */
const INTRO_QUERY =
  "(min-width: 640px) and (prefers-reduced-motion: no-preference)";
/** The pointer sets off once the menu bar has dropped in (260 ms delay + 640 ms). */
const INTRO_START_MS = 1100;
const GLIDE_MS = 1000;
const PRESS_MS = 140;
const EASE_GLIDE = "cubic-bezier(0.45, 0, 0.2, 1)";
const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";

type Box = { left: number; top: number; width: number; height: number };

/** The StatGlass item in the strip: the last item before the clock. */
function itemBox(root: HTMLElement): Box | null {
  const strip = root.querySelector<HTMLElement>('[role="img"]');
  const item = strip?.children[strip.children.length - 2];
  if (!item) return null;
  const r = item.getBoundingClientRect();
  const o = root.getBoundingClientRect();
  return {
    left: r.left - o.left - 5,
    top: r.top - o.top - 3,
    width: r.width + 10,
    height: r.height + 6,
  };
}

/** The macOS arrow pointer, tip at the top-left corner. */
function Pointer() {
  return (
    <svg width="17" height="24" viewBox="0 0 17 24" aria-hidden="true">
      <path
        d="M1.5 1.5v18.2l4.6-4.4 3 6.9 3.1-1.3-3-6.8h6.3z"
        fill="#000"
        stroke="#fff"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The hero's menu bar item and the popover under it. On a wide screen the
 * popover starts closed: a pointer glides up to the StatGlass item and
 * clicks it, and the popover drops open, as it does on a Mac. The item is a
 * real toggle, so a visitor can close and reopen it.
 */
export function HeroTray() {
  const root = useRef<HTMLDivElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const popoverId = useId();
  const [open, setOpen] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [pointer, setPointer] = useState(false);
  const [box, setBox] = useState<Box | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  const intro = useRef<"waiting" | "playing" | "done">("waiting");
  const timers = useRef<number[]>([]);
  const mountedAt = useRef(0);

  const lit = open || pressed;
  const onReady = useCallback(() => setFrameReady(true), []);

  useEffect(() => {
    mountedAt.current = performance.now();
    if (!matchMedia(INTRO_QUERY).matches) {
      intro.current = "done";
      setOpen(true);
    }
    const pending = timers.current;
    return () => {
      for (const t of pending) clearTimeout(t);
    };
  }, []);

  // Wait for the popover to paint, so it never opens empty.
  useEffect(() => {
    if (!frameReady || intro.current !== "waiting") return;
    const wait = INTRO_START_MS - (performance.now() - mountedAt.current);
    timers.current.push(
      window.setTimeout(
        () => {
          if (intro.current !== "waiting") return;
          intro.current = "playing";
          setPointer(true);
        },
        Math.max(0, wait)
      )
    );
  }, [frameReady]);

  // Glide, press, open, then drift away and fade.
  useLayoutEffect(() => {
    const el = cursor.current;
    const rootEl = root.current;
    if (!pointer || !el || !rootEl) return;
    const target = itemBox(rootEl);
    if (!target) {
      intro.current = "done";
      setPointer(false);
      setOpen(true);
      return;
    }
    const width = rootEl.clientWidth;
    const from = `translate(${width * 0.3}px, ${rootEl.clientHeight * 0.5}px)`;
    const tipX = target.left + target.width * 0.55;
    const tipY = target.top + target.height * 0.55;
    const at = `translate(${tipX}px, ${tipY}px)`;
    const glide = el.animate(
      [
        { transform: from, opacity: 0 },
        { transform: from, opacity: 1, offset: 0.12 },
        { transform: at, opacity: 1 },
      ],
      { duration: GLIDE_MS, easing: EASE_GLIDE, fill: "forwards" }
    );
    glide.onfinish = () => {
      setBox(target);
      setPressed(true);
      el.animate(
        [
          { transform: at },
          { transform: `${at} scale(0.86)` },
          { transform: at },
        ],
        { duration: PRESS_MS * 2, easing: "ease-out" }
      );
      timers.current.push(
        window.setTimeout(() => {
          setPressed(false);
          setOpen(true);
          intro.current = "done";
          const away = `translate(${tipX + 18}px, ${tipY + 34}px)`;
          const leave = el.animate(
            [
              { transform: at, opacity: 1 },
              { transform: away, opacity: 0 },
            ],
            { duration: 600, delay: 300, easing: EASE_OUT, fill: "forwards" }
          );
          leave.onfinish = () => setPointer(false);
        }, PRESS_MS)
      );
    };
    return () => glide.cancel();
  }, [pointer]);

  // Keep the highlight on the item if the layout moves while it's lit.
  useEffect(() => {
    const rootEl = root.current;
    if (!lit || !rootEl) return;
    const measure = () => setBox(itemBox(rootEl));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [lit]);

  const toggle = () => {
    // A visitor who clicks first takes over from the intro.
    intro.current = "done";
    setPointer(false);
    setOpen((o) => !o);
  };

  return (
    <div
      ref={root}
      data-nosnippet
      className="relative flex w-full max-w-[360px] flex-col gap-1.5 justify-self-center"
    >
      <div
        data-motion="drop"
        style={{ "--sf-reveal-delay": "260ms" } as CSSProperties}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls={popoverId}
          aria-label="StatGlass in the menu bar"
          onClick={toggle}
          className="block w-full cursor-default rounded-control text-left"
        >
          <MenuBarItem />
        </button>
      </div>
      {lit && box && (
        <span
          aria-hidden="true"
          className={styles.highlight}
          style={{
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
          }}
        />
      )}
      <div
        id={popoverId}
        className={styles.popover}
        data-open={open ? "" : undefined}
        inert={!open}
      >
        <PopoverDemo onReady={onReady} />
      </div>
      {pointer && (
        <div ref={cursor} className={styles.cursor} style={{ opacity: 0 }}>
          <Pointer />
        </div>
      )}
    </div>
  );
}
