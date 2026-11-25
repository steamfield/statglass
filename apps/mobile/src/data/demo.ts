/**
 * Demo mode's transport: the shared mock transport running the hosts
 * dashboard and incompatible-host scenarios the desktop tests use.
 */
import type { LiveMsg } from "@core/generated/types";
import { createMockTransport } from "@core/mock-transport";
import { useEffect } from "react";
import type { PhoneTransport } from "./seam";
import {
  useIsDemo,
  useOptionalPhoneTransport,
  useSetPhoneTransport,
} from "./transport-context";

type DemoTransport = PhoneTransport & { dispose(): void };

function demoLiveReceiver(
  isUnavailable: () => boolean,
  receive: (message: LiveMsg) => void
) {
  let status: Extract<LiveMsg, { kind: "status" }> | undefined;
  let reportedUnavailable: boolean | undefined;
  return (message: LiveMsg) => {
    if (message.kind !== "status" && message.kind !== "frame") {
      receive(message);
      return;
    }
    if (message.kind === "status") status = message;
    const unavailable = isUnavailable();
    if (
      status &&
      (message.kind === "status" || unavailable !== reportedUnavailable)
    ) {
      reportedUnavailable = unavailable;
      // Zero cadence tells the phone to expect cached history only.
      receive(
        unavailable ? { ...status, interval_ms: 0, frame_period_ms: 0 } : status
      );
    }
    if (message.kind === "frame" && !unavailable) receive(message);
  };
}

/** A fresh demo transport; each call starts its own mock hosts. */
export function createDemoTransport(): DemoTransport {
  const transport = createMockTransport({
    scenarios: ["hosts-dashboard", "host-incompatible"],
    autoTick: true,
  });
  let unavailable: Set<string> | null = null;
  const refreshAvailability = () => {
    void transport.listRemoteHosts().then((remotes) => {
      unavailable = new Set(
        remotes
          .filter(({ status }) => status.state !== "connected")
          .map(({ config }) => config.id)
      );
    });
  };
  transport.onRemoteHostsChanged(refreshAvailability);
  refreshAvailability();

  return {
    ...transport,
    subscribeLive(host, receive, options) {
      // The mock peer keeps sampling locally. An unavailable connection can
      // deliver its cached history, but cannot send current samples to the phone.
      return transport.subscribeLive(
        host,
        demoLiveReceiver(() => unavailable?.has(host) !== false, receive),
        options
      );
    },
  };
}

/** Disposes demo tickers when the session ends, the transport changes or the root unmounts. */
export function useDemoLifetime(hasDemoRoute: boolean) {
  const transport = useOptionalPhoneTransport();
  const demo = useIsDemo();
  const setTransport = useSetPhoneTransport();
  useEffect(() => {
    if (demo && !hasDemoRoute) setTransport(null, false);
  }, [demo, hasDemoRoute, setTransport]);
  useEffect(() => {
    if (
      demo &&
      transport &&
      "dispose" in transport &&
      typeof transport.dispose === "function"
    ) {
      const dispose = transport.dispose.bind(transport);
      return dispose;
    }
  }, [demo, transport]);
}
