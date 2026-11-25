/**
 * Reads the core's JSON envelopes into the desktop's `CommandResult`, so
 * screens branch on `status` exactly as they do on the desktop.
 */
import type {
  BuildInfo,
  Capabilities,
  HostAddressesInfo,
  HostHistoryPage,
  HostRecord,
  HostVitals,
  MobileCall,
  MobileRemoteHost,
  SubscriptionInfo,
} from "@core/generated/types";
import type { NativeError } from "@core/native-errors";
import type { CommandResult } from "@core/transport";
import {
  type StatglassNativeModule,
  toNativeModuleError,
} from "@native/statglass-native";

// Track crates/statglass-mobile/src/sessions/commands.rs and
// crates/statglass-mobile/src/mobile_core.rs for each method's result.
type MobileCallResult = {
  build_info: BuildInfo;
  set_hosts: null;
  set_data_policy: null;
  authorized_key_line: string;
  list_hosts: HostRecord[];
  list_remote_hosts: MobileRemoteHost[];
  get_host: HostRecord;
  get_capabilities: Capabilities;
  host_vitals: HostVitals;
  retry_remote_host: null;
  subscribe_live: SubscriptionInfo;
  unsubscribe_live: null;
  host_history: HostHistoryPage;
  network_addresses: HostAddressesInfo;
  set_process_interest: null;
};

/**
 * The envelope in `json`. A string that is not an envelope becomes an
 * `internal` error naming what arrived, never a throw.
 */
export function parseEnvelope<T>(json: string): CommandResult<T> {
  try {
    const value: unknown = JSON.parse(json);
    if (
      typeof value === "object" &&
      value !== null &&
      "status" in value &&
      ((value.status === "ok" && "data" in value) ||
        (value.status === "error" && "error" in value))
    ) {
      return value as CommandResult<T>;
    }
  } catch {
    // Invalid JSON and a missing envelope have the same diagnostic.
  }
  return {
    status: "error",
    error: {
      kind: "internal",
      message: `Invalid core response: "${json.slice(0, 200)}"`,
    },
  };
}

/** Reads event JSON from the core and drops it if decoding fails. */
export function parseEvent<T>(
  json: string,
  what: string,
  report = warnInvalidEvent
): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    report(json, what);
    return null;
  }
}

function warnInvalidEvent(json: string, what: string) {
  const preview = typeof json === "string" ? json.slice(0, 200) : typeof json;
  console.warn(`[native core] invalid ${what} JSON`, preview);
}

/** Create one decoder for each subscription's event stream. */
export function createEventParser<T>(what: string): (json: string) => T | null {
  let warned = false;
  function warnOnce(json: string) {
    if (warned) return;
    warned = true;
    warnInvalidEvent(json, what);
  }
  return (json) => parseEvent<T>(json, what, warnOnce);
}

/** Decodes an Expo error without confusing it with a Rust command error. */
function nativeRejection(error: unknown): NativeError | null {
  try {
    const decoded = toNativeModuleError(error);
    return decoded ? { source: "native", ...decoded } : null;
  } catch (parseError) {
    console.warn(
      "[native core] could not decode native call rejection",
      parseError
    );
    return null;
  }
}

/** Explicitly provisions the phone's key before pairing. */
export async function preparePhoneKey(
  native: StatglassNativeModule
): Promise<void> {
  try {
    await native.preparePhoneKey();
  } catch (error) {
    throw nativeRejection(error) ?? error;
  }
}

function rejectionMessage(error: unknown): string {
  try {
    if (
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string"
    ) {
      return error.message;
    }
    return String(error);
  } catch {
    return "Unknown native error";
  }
}

/** Compatibility entry point while the existing transport callers migrate. */
export async function callCore<T>(
  native: StatglassNativeModule,
  request: MobileCall
): Promise<CommandResult<T>> {
  const args = "args" in request ? request.args : null;
  try {
    return parseEnvelope(
      await native.call(request.method, JSON.stringify(args))
    );
  } catch (error) {
    return {
      status: "error",
      error: {
        kind: "internal",
        message: `${request.method} failed: ${rejectionMessage(error).slice(0, 200)}`,
      },
    };
  }
}

/** A facade call returns the result declared for its method. */
export function callCoreByMethod<M extends MobileCall["method"]>(
  native: StatglassNativeModule,
  request: MobileCall & { method: M }
): Promise<CommandResult<MobileCallResult[M]>> {
  return callCore(native, request);
}
