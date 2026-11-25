/** The `statglass-native` Expo module: the app's pipe to its Rust core. */
import type { StatglassNativeModule } from "./src/StatglassNative.types";
import { getStatglassNative as loadNativeModule } from "./src/StatglassNativeModule";

export { toNativeModuleError } from "./src/native-error";
export type {
  CoreEventPayload,
  LivePayload,
  NativeModuleError,
  NativeModuleErrorKind,
  StatglassNativeEvents,
  StatglassNativeModule,
} from "./src/StatglassNative.types";

let nativeForTests: StatglassNativeModule | null | undefined;

/** Test seam for overriding the native module loader. */
export function __setNativeForTests(
  native: StatglassNativeModule | null | undefined
): void {
  nativeForTests = native;
}

export function getStatglassNative(): StatglassNativeModule | null {
  if (nativeForTests !== undefined) return nativeForTests;
  return loadNativeModule();
}
