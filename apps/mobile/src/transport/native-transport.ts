/**
 * The phone's real transport: the `PhoneTransport` seam over the native
 * core, so every screen reads a paired host the way it reads the demo.
 */
import type {
  BuildInfo,
  CommandError,
  DataPolicy,
  HostId,
  HostRecord,
  MobileConfig,
  MobileEvent,
  MobileHost,
  MobileRemoteHost,
} from "@core/generated/types";
import type { CommandResult } from "@core/transport";
import { unwrap } from "@core/transport/query";
import type { StatglassNativeModule } from "@native/statglass-native";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { PhonePairing } from "@/data/pairing-seam";
import type { PhoneTransport } from "@/data/seam";
import {
  callCore,
  callCoreByMethod,
  parseEnvelope,
  parseEvent,
  preparePhoneKey,
} from "./envelope";
import { createLiveStreams } from "./live-streams";
import { toRemoteHostRecord } from "./remote-hosts";

/** The seam plus what only the native core does. */
export interface NativeTransport extends PhoneTransport {
  /** Replaces the configured hosts and serializes writes on this transport. */
  setHosts(hosts: MobileHost[]): Promise<CommandResult<null>>;
  removeHost(host: HostId): Promise<CommandResult<null>>;
  /** Updates the live data policy. */
  setDataPolicy(policy: DataPolicy): Promise<CommandResult<null>>;
  /** The `authorized_keys` line for this phone's key. */
  authorizedKeyLine(comment: string): Promise<CommandResult<string>>;
  /** Reads the running core's version and supported protocol range. */
  buildInfo(): Promise<CommandResult<BuildInfo>>;
  /** Ends every stream and listener; the core keeps running. */
  dispose(): void;
}

type Pair = PhonePairing["pair"];
type NativePairing = PhonePairing & {
  pair(...args: [...Parameters<Pair>, signal?: AbortSignal]): ReturnType<Pair>;
};

// Keep phone-only pairing and policy feedback off the shared transport seam.
const services = new WeakMap<
  NativeTransport,
  { pairing: NativePairing; policyError: StoreApi<CommandError | null> }
>();
const noPolicyError = createStore<CommandError | null>(() => null);

/**
 * Starts the core with `config` and returns the transport over it.
 * @throws the original Expo error if data-directory setup fails
 */
export async function startNativeTransport(
  native: StatglassNativeModule,
  config: MobileConfig
): Promise<CommandResult<NativeTransport>> {
  const result = await startNativeCore(native, config);
  return result.status === "error"
    ? result
    : { status: "ok", data: createNativeTransport(native) };
}

/** Starts the Rust core independently of the JS transport's lifetime. */
export async function startNativeCore(
  native: StatglassNativeModule,
  config: MobileConfig
): Promise<CommandResult<null>> {
  const json = await native.start(JSON.stringify(config));
  return parseEnvelope<null>(json);
}

/** The transport over a core that has already started. */
export function createNativeTransport(
  native: StatglassNativeModule
): NativeTransport {
  const live = createLiveStreams(native);
  const subscriptions = new Set<() => void>();
  let disposed = false;
  let hostsPending = Promise.resolve();

  function onCoreEvent(cb: (event: MobileEvent) => void) {
    if (disposed) return () => undefined;
    const listener = native.addListener("onCoreEvent", ({ event }) => {
      const message = parseEvent<MobileEvent>(event, "onCoreEvent");
      if (message === null) return;
      try {
        cb(message);
      } catch (error) {
        console.warn("[native core] onCoreEvent subscriber failed", error);
      }
    });
    function unsubscribe() {
      if (subscriptions.delete(unsubscribe)) listener.remove();
    }
    subscriptions.add(unsubscribe);
    return unsubscribe;
  }

  const policyError = createStore<CommandError | null>(() => null);
  const transport: NativeTransport = {
    listHosts: () =>
      unwrap(callCore<HostRecord[]>(native, { method: "list_hosts" })),
    async listRemoteHosts() {
      const hosts = await unwrap(
        callCore<MobileRemoteHost[]>(native, { method: "list_remote_hosts" })
      );
      return hosts.map(toRemoteHostRecord);
    },
    onHostsChanged: (cb) =>
      onCoreEvent((event) => {
        if (event.kind === "hosts_changed") cb({ hosts: event.hosts });
      }),
    onRemoteHostsChanged: (cb) =>
      onCoreEvent((event) => {
        if (event.kind === "remote_hosts_changed") cb({});
      }),
    getHost: (host) => callCore(native, { method: "get_host", args: { host } }),
    getCapabilities: (host) =>
      callCore(native, { method: "get_capabilities", args: { host } }),
    hostVitals: (host) =>
      callCore(native, { method: "host_vitals", args: { host } }),
    retryRemoteHost: (host) =>
      callCore(native, { method: "retry_remote_host", args: { host } }),
    subscribeLive: live.open,
    hostHistory: (args) => callCore(native, { method: "host_history", args }),
    networkAddresses: (host) =>
      callCore(native, {
        method: "network_addresses",
        args: { host },
      }),
    setDemand: (demand) =>
      callCore(native, { method: "set_demand", args: { demand } }),
    setProcessInterest: (host, interested, view, stream) =>
      callCore(native, {
        method: "set_process_interest",
        args: { host, interested, view, stream },
      }),
    pairingState: () => callCore(native, { method: "pairing_state" }),
    removeHost: (host) =>
      callCore(native, { method: "remove_host", args: { host } }),
    setHosts(hosts) {
      // A debug screen can unmount during Connect or reopen during cleanup.
      const write = hostsPending.then(() =>
        callCore<null>(native, { method: "set_hosts", args: { hosts } })
      );
      hostsPending = write.then(() => undefined);
      return write;
    },
    async setDataPolicy(args) {
      const result = await callCoreByMethod(native, {
        method: "set_data_policy",
        args,
      });
      policyError.setState(
        result.status === "error" ? result.error : null,
        true
      );
      return result;
    },
    authorizedKeyLine: (comment) =>
      callCore(native, { method: "authorized_key_line", args: { comment } }),
    buildInfo: () => callCore(native, { method: "build_info" }),
    dispose() {
      disposed = true;
      for (const unsubscribe of subscriptions) unsubscribe();
      live.dispose();
    },
  };
  services.set(transport, {
    policyError,
    pairing: {
      previewPairing: (text) =>
        callCoreByMethod(native, { method: "preview_pairing", args: { text } }),
      async pair(text, deviceName, model, signal?: AbortSignal) {
        await preparePhoneKey(native);
        if (signal?.aborted) {
          return {
            status: "error",
            error: { kind: "internal", message: "Pairing cancelled" },
          };
        }
        return callCoreByMethod(native, {
          method: "pair",
          args: { text, device_name: deviceName, model },
        });
      },
    },
  });
  return transport;
}

export function nativePairing(core: NativeTransport): NativePairing {
  const pairing = services.get(core)?.pairing;
  if (!pairing) throw new Error("Pairing requires a native core transport");
  return pairing;
}

export function useDataPolicyError(core: NativeTransport | null) {
  return useStore((core && services.get(core)?.policyError) || noPolicyError);
}

/** Whether `transport` is the native one (it carries the native-only calls). */
export function isNativeTransport(
  transport: PhoneTransport | null
): transport is NativeTransport {
  return transport !== null && "setDataPolicy" in transport;
}
