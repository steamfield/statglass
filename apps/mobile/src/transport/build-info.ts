/**
 * What the About screen says about the Rust core: its version and the
 * session protocol range it speaks, from the native module's `version()`.
 */
import type { BuildInfo } from "@core/generated/types";
import type { StatglassNativeModule } from "@native/statglass-native";

/** The core's build info, or `null` without a native module or on an error. */
export function nativeBuildInfo(
  native: StatglassNativeModule | null
): BuildInfo | null {
  void native;
  throw new Error("nativeBuildInfo: not implemented (phase 4 lane c)");
}

/** The protocol range as the About screen shows it, for example "3 to 5". */
export function protocolRangeText(info: BuildInfo): string {
  void info;
  throw new Error("protocolRangeText: not implemented (phase 4 lane c)");
}
