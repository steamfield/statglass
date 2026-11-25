/**
 * Reads the typed module error out of a rejected native call. Swift rejects
 * with an Expo exception whose code names the kind and whose message carries
 * the `OSStatus`; this is the one place that format is parsed.
 */
import type { NativeModuleError } from "./StatglassNative.types";

/**
 * The module error in `error`, or `null` when it is not one (a JS error, or
 * a rejection from Expo itself).
 */
export function toNativeModuleError(error: unknown): NativeModuleError | null {
  void error;
  throw new Error("toNativeModuleError: not implemented (phase 4 lane b)");
}
