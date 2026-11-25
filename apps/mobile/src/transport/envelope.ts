/**
 * Reads the core's JSON envelopes into the desktop's `CommandResult`, so
 * screens branch on `status` exactly as they do on the desktop.
 */
import type { MobileCall } from "@core/generated/types";
import type { CommandResult } from "@core/transport";
import {
  type StatglassNativeModule,
  toNativeModuleError,
} from "@native/statglass-native";

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
export function parseEvent<T>(json: string, what: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    const preview = typeof json === "string" ? json.slice(0, 200) : typeof json;
    console.warn(`[native core] invalid ${what} JSON`, preview);
    return null;
  }
}

function rejectionMessage(error: unknown): string {
  try {
    const nativeError = toNativeModuleError(error);
    if (nativeError) {
      const { kind, message, osStatus } = nativeError;
      return osStatus === null
        ? `${kind}: ${message}`
        : `${kind} (OSStatus ${osStatus}): ${message}`;
    }
  } catch (parseError) {
    console.warn(
      "[native core] could not decode native call rejection",
      parseError
    );
  }

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

/** Sends a generated facade request over the module's split wire interface. */
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
