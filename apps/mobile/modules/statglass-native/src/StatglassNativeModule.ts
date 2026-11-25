/**
 * Loads the native module. It is absent under jest, in Expo Go and before a
 * native build that includes it, so callers get `null` instead of a throw.
 */
import { requireOptionalNativeModule } from "expo";
import type { StatglassNativeModule } from "./StatglassNative.types";

let loaded: StatglassNativeModule | null | undefined;

/** The native module, or `null` when this build has none. */
export function getStatglassNative(): StatglassNativeModule | null {
  if (loaded === undefined) {
    loaded =
      requireOptionalNativeModule<StatglassNativeModule>("StatglassNative");
  }
  return loaded;
}
