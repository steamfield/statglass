import type { Transport } from "@core/transport";
import type { MotionSource } from "@steamfield/ui/playback";
import { useEffect, useMemo, useState } from "react";
import { useTransport } from "~/lib/transport-context";

/**
 * MotionSource for error-state `<Gif />` playback in StatGlass: allows motion
 * only when Reduced Motion is off AND Performance mode (`data-performance` on
 * `<html>`) is off. Kept separate from native window visibility, which drives
 * `<Gif active={visible} />` so hidden/closed-to-tray windows decode zero video
 * frames without triggering reduced-motion fallback mode.
 */
function createStatGlassMotionSource(): MotionSource {
  const prefersReduced = () =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isPerformanceMode = () =>
    typeof document !== "undefined" &&
    document.documentElement.hasAttribute("data-performance");
  const get = () => !prefersReduced() && !isPerformanceMode();

  return {
    get,
    subscribe(listener: () => void) {
      if (typeof window === "undefined" || typeof document === "undefined") {
        return () => {};
      }
      const mq =
        typeof window.matchMedia === "function"
          ? window.matchMedia("(prefers-reduced-motion: reduce)")
          : null;
      mq?.addEventListener("change", listener);
      const observer = new MutationObserver(listener);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-performance"],
      });
      return () => {
        mq?.removeEventListener("change", listener);
        observer.disconnect();
      };
    },
  };
}

/**
 * Native window visibility for `<Gif active={...} />`. Uses `transport`'s
 * native visibility channel so a closed-to-tray or occluded dashboard pauses
 * `<video>` playback immediately even when WKWebView's `visibilityState` lags.
 */
function useNativeWindowVisible(
  transport: Transport,
  enabled: boolean
): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let receivedEvent = false;
    const unsubscribe = transport.onWindowVisibility((next) => {
      if (!active) return;
      receivedEvent = true;
      setVisible(next);
    });
    void transport.windowVisible().then(
      (next) => {
        if (active && !receivedEvent) setVisible(next);
      },
      () => {
        // Keep visible=true if visibility query fails in an error fallback.
      }
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [transport, enabled]);
  return enabled ? visible : false;
}

/** Stable `motion` source and `active` visibility gate for `<Gif />` in StatGlass. */
export function useGifPlaybackGate(enabled = true): {
  readonly motion: MotionSource;
  readonly active: boolean;
} {
  const transport = useTransport();
  const active = useNativeWindowVisible(transport, enabled);
  const motion = useMemo(() => createStatGlassMotionSource(), []);
  return { motion, active };
}
