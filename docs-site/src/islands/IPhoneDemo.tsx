import { memo, type ReactNode, useEffect, useRef } from "react";
import { BackButton } from "@/islands/iphone/chrome";
import { CpuScreen } from "@/islands/iphone/CpuScreen";
import { HostScreen } from "@/islands/iphone/HostScreen";
import { HostsScreen } from "@/islands/iphone/HostsScreen";
import { PhoneFrame } from "@/islands/iphone/PhoneFrame";
import { DEMO_HOSTS } from "@/islands/iphone/phone-data";
import styles from "@/islands/iphone/phone.module.css";
import { useEdgeSwipe } from "@/islands/iphone/use-edge-swipe";
import { usePhoneHosts } from "@/islands/iphone/use-phone-hosts";
import { type Route, usePhoneNav } from "@/islands/iphone/use-phone-nav";

/** Longest a pop waits for its transition before dropping the screen. */
const POP_FALLBACK_MS = 600;

/**
 * A covered screen keeps its last frame: only the screen on top (and one
 * leaving) re-renders at 1 Hz, as on the phone.
 */
const Frozen = memo(
  ({ children }: { live: boolean; children: ReactNode }) => children,
  (_, next) => !next.live
);

/** Slides a pushed screen in from the right, once, as it mounts. */
function slideIn(el: HTMLElement | null) {
  if (!el || el.dataset.entered !== undefined) return;
  el.dataset.entered = "";
  if (!matchMedia("(prefers-reduced-motion: no-preference)").matches) return;
  el.animate?.([{ transform: "translateX(100%)" }, { transform: "none" }], {
    duration: 500,
    easing: "cubic-bezier(0.32, 0.72, 0, 1)",
  });
}

function titleOf(route: Route): string {
  if (route.screen === "hosts") return "Hosts";
  if (route.screen === "cpu") return "CPU";
  return DEMO_HOSTS.find((h) => h.id === route.host)?.name ?? "Host";
}

/**
 * StatGlass for iPhone, recreated for the landing page on simulated data:
 * the hosts list, a host's module cards and the CPU page, in a UIKit-style
 * navigation stack with the interactive swipe back. Its charts are the
 * app's own widgets, so they draw as they do in the desktop app.
 */
export function IPhoneDemo() {
  const { ref, series, tEndMs } = usePhoneHosts();
  const nav = usePhoneNav();
  const stackRef = useRef<HTMLDivElement>(null);

  // A popped screen leaves on its transition; drop it when that ends, or
  // straight away when there is no transition (reduced motion).
  const leavingKey = nav.leaving?.key;
  useEffect(() => {
    if (leavingKey === undefined) return;
    const timer = setTimeout(() => nav.settle(leavingKey), POP_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [leavingKey, nav.settle]);

  // Keyboard users stay in the phone as screens change: on the new screen's
  // back button after a push, on the uncovered screen's after a pop (or its
  // first control on the hosts list).
  const depth = nav.stack.length;
  const keepFocus = useRef(false);
  useEffect(() => {
    if (!keepFocus.current) return;
    keepFocus.current = false;
    const top = stackRef.current?.querySelector<HTMLElement>(
      ':scope > [data-state="top"]'
    );
    const target =
      top?.querySelector<HTMLElement>("[data-back]") ??
      top?.querySelector<HTMLElement>("button");
    target?.focus({ preventScroll: true });
  }, [depth]);
  const focusInside = () =>
    stackRef.current?.contains(document.activeElement) ?? false;
  const push = (route: Route) => {
    keepFocus.current = focusInside();
    nav.push(route);
  };
  const pop = () => {
    keepFocus.current = focusInside();
    nav.pop();
  };
  useEdgeSwipe(stackRef, nav.stack.length > 1, pop);

  const entries = nav.leaving ? [...nav.stack, nav.leaving] : nav.stack;
  return (
    <figure
      ref={ref}
      data-demo=""
      data-nosnippet=""
      className="flex flex-col items-center gap-6"
    >
      <PhoneFrame>
        <div
          ref={stackRef}
          className="absolute inset-0 select-none"
          style={{ touchAction: "pan-y pinch-zoom" }}
          role="group"
          aria-label="StatGlass for iPhone, demo with simulated data"
        >
          {entries.map((entry, index) => {
            const leaving = entry === nav.leaving;
            const top = !leaving && index === nav.stack.length - 1;
            const below = nav.stack[index - 1];
            const back = below ? (
              <BackButton label={titleOf(below.route)} onPress={pop} />
            ) : null;
            const route = entry.route;
            const host =
              route.screen === "hosts"
                ? undefined
                : DEMO_HOSTS.find((h) => h.id === route.host);
            const data = host ? series[host.id] : undefined;
            return (
              <div
                key={entry.key}
                ref={entry.key === 0 ? undefined : slideIn}
                data-layer=""
                data-state={leaving ? "leaving" : top ? "top" : "below"}
                data-pushed={entry.key === 0 ? undefined : ""}
                className={styles.layer}
                inert={!top}
                onTransitionEnd={(event) => {
                  if (leaving && event.target === event.currentTarget) {
                    nav.settle(entry.key);
                  }
                }}
              >
                <Frozen live={top || leaving}>
                  {route.screen === "hosts" ? (
                    <HostsScreen
                      series={series}
                      tEndMs={tEndMs}
                      onOpen={(id) => push({ screen: "host", host: id })}
                    />
                  ) : host && data && route.screen === "host" ? (
                    <HostScreen
                      host={host}
                      data={data}
                      tEndMs={tEndMs}
                      back={back}
                      onOpenCpu={() => push({ screen: "cpu", host: host.id })}
                    />
                  ) : host && data ? (
                    <CpuScreen
                      host={host}
                      data={data}
                      tEndMs={tEndMs}
                      back={back}
                    />
                  ) : null}
                </Frozen>
              </div>
            );
          })}
        </div>
      </PhoneFrame>
      <figcaption className="max-w-[300px] text-center text-xs leading-relaxed font-normal text-muted-foreground">
        Simulated data. Tap a host, then its CPU card. Swipe from the left edge
        of the screen to go back.
      </figcaption>
    </figure>
  );
}
