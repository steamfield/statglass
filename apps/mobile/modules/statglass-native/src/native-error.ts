/**
 * Reads the typed module error out of a rejected native call. Swift rejects
 * with an Expo exception whose code names the kind and whose message carries
 * the `OSStatus`; this is the one place that format is parsed.
 */
import type {
  NativeModuleError,
  NativeModuleErrorKind,
} from "./StatglassNative.types";

const kinds = new Map<string, NativeModuleErrorKind>([
  ["ERR_STATGLASS_KEYCHAIN", "keychain"],
  ["ERR_STATGLASS_SECURE_ENCLAVE", "secureEnclave"],
  ["ERR_STATGLASS_CAMERA", "camera"],
]);

/**
 * The module error in `error`, or `null` when it is not one (a JS error, or
 * a rejection from Expo itself).
 */
export function toNativeModuleError(error: unknown): NativeModuleError | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    typeof error.code !== "string" ||
    !("message" in error) ||
    typeof error.message !== "string"
  ) {
    return null;
  }

  const kind = kinds.get(error.code);
  if (!kind) return null;

  const status = / \(OSStatus (-?\d+)\)$/.exec(error.message);
  return {
    kind,
    osStatus: status ? Number(status[1]) : null,
    message: status ? error.message.slice(0, status.index) : error.message,
  };
}
