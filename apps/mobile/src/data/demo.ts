/**
 * Demo mode's transport: the shared mock transport running the hosts
 * dashboard and incompatible-host scenarios the desktop tests use.
 */
import type { LiveMsg } from "@core/generated/types";
import { SCENARIOS } from "@core/mock/fixtures";
import { phoneDemoOptions } from "@core/mock/history";
import { createMockTransport } from "@core/mock-transport";
import { useNavigationContainerRef, useRouter } from "expo-router";
import {
  createContext,
  createElement,
  type JSX,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { useNativeCore } from "@/transport";
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
export function createDemoTransport(scenario?: string): DemoTransport {
  const requested = SCENARIOS.find((name) => name === scenario);
  const transport = createMockTransport(
    phoneDemoOptions({
      scenarios: requested
        ? [requested]
        : ["hosts-dashboard", "host-incompatible"],
      autoTick: true,
    })
  );
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

interface DemoSession {
  active: boolean;
  start(scenario?: string): void;
  exit(): void;
}

const DemoContext = createContext<DemoSession | null>(null);

/** Owns the mock transport for the duration of a demo session. */
export function DemoProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const active = useIsDemo();
  const transport = useOptionalPhoneTransport();
  const setTransport = useSetPhoneTransport();
  const { core } = useNativeCore();
  const router = useRouter();
  const navigation = useNavigationContainerRef();
  const owned = useRef<DemoTransport | null>(null);
  const dispose = useCallback(() => {
    owned.current?.dispose();
    owned.current = null;
  }, []);

  useEffect(() => dispose, [dispose]);
  useEffect(() => {
    // The demo route can start the session in a child effect before selection commits.
    if (transport === null || transport !== owned.current) return;
    return () => {
      if (transport === owned.current) dispose();
    };
  }, [dispose, transport]);

  const start = useCallback(
    (scenario?: string) => {
      dispose();
      const next = createDemoTransport(scenario);
      owned.current = next;
      setTransport(next, true);
      router.replace("/(hosts)");
    },
    [dispose, router, setTransport]
  );
  const exit = useCallback(() => {
    const demo = owned.current;
    if (!demo) return;
    dispose();
    setTransport(core, false, demo);
    // The hosts index shares the `/` path. Target the welcome route in the root stack.
    const root = navigation.getRootState();
    const target = root.routes[root.index]?.state?.key ?? root.key;
    navigation.dispatch({
      type: "REPLACE",
      payload: { name: "index" },
      target,
    });
  }, [core, dispose, navigation, setTransport]);
  const value = useMemo(() => ({ active, start, exit }), [active, start, exit]);
  return createElement(DemoContext.Provider, { value }, children);
}

export function useDemo(): DemoSession {
  const demo = useContext(DemoContext);
  if (!demo) throw new Error("useDemo requires DemoProvider");
  return demo;
}
