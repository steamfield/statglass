import { commandError, commandErrorText } from "@core/command-error";
import type { CommandError, MobileConfig } from "@core/generated/types";
import { isNativeError, type NativeError } from "@core/native-errors";
import { unwrap } from "@core/transport";
import {
  getStatglassNative,
  type StatglassNativeModule,
  toNativeModuleError,
} from "@native/statglass-native";
import {
  createContext,
  type JSX,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { usePhoneSettings } from "@/data/phone-settings";
import {
  useOptionalPhoneTransport,
  useSetPhoneTransport,
} from "@/data/transport-context";
import {
  createNativeTransport,
  type NativeTransport,
  startNativeCore,
} from "./native-transport";

type CoreError = NativeError | CommandError;
type CoreState =
  | { status: "starting" | "unavailable" }
  | { status: "ready"; core: NativeTransport; hasHosts: boolean }
  | { status: "failed"; error: CoreError };

interface CoreValue {
  core: NativeTransport | null;
  error: CoreError | null;
  retry(): void;
}

const StartingContext = createContext(false);
const CoreContext = createContext<CoreValue>({
  core: null,
  error: null,
  retry() {},
});

// Swift keeps the Rust core alive across navigation remounts. Remember only
// startup, so a new provider can attach its own transport and listeners.
const starts = new WeakMap<StatglassNativeModule, Promise<null>>();

function startOnce(native: StatglassNativeModule, config: MobileConfig) {
  const existing = starts.get(native);
  if (existing) return existing;
  const started = unwrap(startNativeCore(native, config)).catch(
    (error: unknown) => {
      starts.delete(native);
      throw error;
    }
  );
  starts.set(native, started);
  return started;
}

function startupError(error: unknown): CoreError {
  if (isNativeError(error)) return error;
  const native = toNativeModuleError(error);
  if (native) return { ...native, source: "native" };
  return (
    commandError(error) ?? {
      kind: "internal",
      message: commandErrorText(error, "StatGlass couldn’t start."),
    }
  );
}

export function CoreProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const [state, setState] = useState<CoreState>({ status: "starting" });
  const [attempt, setAttempt] = useState(0);
  const coreRef = useRef<NativeTransport | null>(null);
  const choice = useOptionalPhoneTransport();
  const selectTransport = useSetPhoneTransport();
  const liveOnCellular = usePhoneSettings(
    (settings) => settings.liveOnCellular
  );
  const startupConfig = useEffectEvent(
    (): MobileConfig => ({
      // Phase 8 loads the saved roster in Rust.
      hosts: [],
      data: { live_on_cellular: liveOnCellular },
    })
  );

  useEffect(() => {
    let active = true;
    let rosterEvent: boolean | undefined;

    function disposeCore() {
      const core = coreRef.current;
      if (!core) return;
      coreRef.current = null;
      selectTransport(null, false, core);
      core.dispose();
      setState((current) =>
        current.status === "ready" && current.core === core
          ? { status: "starting" }
          : current
      );
    }

    async function start() {
      const native = getStatglassNative();
      if (native === null) {
        setState({ status: "unavailable" });
        return;
      }
      await startOnce(native, startupConfig());
      if (!active) return;
      const core = createNativeTransport(native);
      coreRef.current = core;
      core.onHostsChanged(({ hosts }) => {
        if (!active) return;
        const hasHosts = hosts.length > 0;
        rosterEvent = hasHosts;
        setState((current) =>
          current.status === "ready" &&
          current.core === core &&
          current.hasHosts !== hasHosts
            ? { ...current, hasHosts }
            : current
        );
      });
      const hosts = await core.listHosts();
      if (active) {
        setState({
          status: "ready",
          core,
          hasHosts: rosterEvent ?? hosts.length > 0,
        });
      }
    }

    void start().catch((error: unknown) => {
      if (!active) return;
      disposeCore();
      const failure = startupError(error);
      console.error("[native core] startup failed", {
        attempt: attempt + 1,
        error: failure,
      });
      setState({ status: "failed", error: failure });
    });
    return () => {
      active = false;
      disposeCore();
    };
  }, [attempt, selectTransport]);

  const selectableCore = state.status === "ready" ? state.core : null;
  const hasHosts = state.status === "ready" && state.hasHosts;
  useEffect(() => {
    if (selectableCore === coreRef.current && hasHosts && choice === null) {
      selectTransport(selectableCore, false);
    }
  }, [choice, hasHosts, selectableCore, selectTransport]);

  const retry = useCallback(() => {
    if (state.status !== "failed") return;
    setState({ status: "starting" });
    setAttempt((current) => current + 1);
  }, [state.status]);

  return (
    <StartingContext.Provider
      value={state.status === "starting" || (hasHosts && choice === null)}
    >
      <CoreContext.Provider
        value={{
          core: selectableCore,
          error: state.status === "failed" ? state.error : null,
          retry,
        }}
      >
        {children}
      </CoreContext.Provider>
    </StartingContext.Provider>
  );
}

export function useNativeCore(): CoreValue {
  return useContext(CoreContext);
}

/** Whether host routes must wait for the startup roster before redirecting. */
export function useNativeCoreStarting(): boolean {
  return useContext(StartingContext);
}
