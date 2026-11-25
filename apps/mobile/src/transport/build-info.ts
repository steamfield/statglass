/**
 * What the About screen says about the Rust core: its version and the
 * session protocol range it speaks, from the native module's `version()`.
 */
import type { BuildInfo } from "@core/generated/types";
import {
  getStatglassNative,
  type StatglassNativeModule,
} from "@native/statglass-native";
import { parseEnvelope } from "./envelope";

/** The core's build info, or `null` without a native module or on an error. */
export function nativeBuildInfo(
  native: StatglassNativeModule | null
): BuildInfo | null {
  if (!native) return null;
  try {
    const result = parseEnvelope<BuildInfo>(native.version());
    return result.status === "ok" ? result.data : null;
  } catch (error) {
    console.warn("[native core] could not read version", error);
    return null;
  }
}

/** Build information for the module installed in this app. */
export function currentNativeBuildInfo(): BuildInfo | null {
  return nativeBuildInfo(getStatglassNative());
}

/** The protocol range as the About screen shows it, for example "3 to 5". */
export function protocolRangeText(info: BuildInfo): string {
  const { protocol_min, protocol_max } = info;
  return protocol_min === protocol_max
    ? `${protocol_min}`
    : `${protocol_min} to ${protocol_max}`;
}
