import { useEffect, useRef } from "react";
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
  useEdgeSwipe(stackRef, nav.stack.length > 1, nav.pop);

  // A popped screen leaves on its transition; drop it when that ends, or
  // straight away when there is no transition (reduced motion).
  const leavingKey = nav.leaving?.key;
  useEffect(() => {
    if (leavingKey === undefined) return;
    const timer = setTimeout(() => nav.settle(leavingKey), POP_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [leavingKey, nav.settle]);

  // Keyboard users land on the new screen's back button after a push.
  const depth = nav.stack.length;
  const focusAfterPush = useRef(false);
  useEffect(() => {
    if (!focusAfterPush.current) return;
    focusAfterPush.current = false;
    const top = stackRef.current?.querySelector<HTMLElement>(
      ':scope > [data-state="top"] [data-back]'
    );
    top?.focus({ preventScroll: true });
  }, [depth]);
  const push = (route: Route) => {
    focusAfterPush.current =
      stackRef.current?.contains(document.activeElement) ?? false;
    nav.push(route);
  };

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
          role="group"
          aria-label="StatGlass for iPhone, demo with simulated data"
        >
          {entries.map((entry, index) => {
            const leaving = entry === nav.leaving;
            const top = !leaving && index === nav.stack.length - 1;
            const below = nav.stack[index - 1];
            const back = below ? (
              <BackButton label={titleOf(below.route)} onPress={nav.pop} />
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
