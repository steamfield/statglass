/** The `statglass-native` Expo module: the app's pipe to its Rust core. */
export { toNativeModuleError } from "./src/native-error";
export type {
  CoreEventPayload,
  LivePayload,
  NativeModuleError,
  NativeModuleErrorKind,
  StatglassNativeEvents,
  StatglassNativeModule,
} from "./src/StatglassNative.types";
export { getStatglassNative } from "./src/StatglassNativeModule";
