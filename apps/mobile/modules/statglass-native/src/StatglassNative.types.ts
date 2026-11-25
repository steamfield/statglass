/**
 * The JS surface of the `statglass-native` Expo module: a pipe to the Rust
 * core (`crates/statglass-mobile`). Every string it returns or emits is JSON
 * the core wrote; this module never reads metric data.
 */
import type { NativeModule } from "expo";

/** One `LiveMsg` for the app's stream `stream`, as the core serialized it. */
export interface LivePayload {
  stream: number;
  /** A `LiveMsg` as JSON. */
  message: string;
}

/** One `MobileEvent`, as the core serialized it. */
export interface CoreEventPayload {
  /** A `MobileEvent` as JSON. */
  event: string;
}

/** The module's events. */
export type StatglassNativeEvents = {
  onLive(payload: LivePayload): void;
  onCoreEvent(payload: CoreEventPayload): void;
};

/**
 * The native module. Swift also drives the core's lifecycle by itself:
 * background entry quiesces it inside a background task, foreground entry
 * resumes it, and `NWPathMonitor` reports path changes. None of that is
 * called from JS.
 */
export interface StatglassNativeModule
  extends InstanceType<typeof NativeModule<StatglassNativeEvents>> {
  /** The core's `version()` envelope (`BuildInfo`); works before `start`. */
  version(): string;
  /**
   * Starts the core with a `MobileConfig` as JSON. Swift prepares the data
   * directory and phone key first. Resolves to an envelope (`null`).
   * @throws an `ERR_STATGLASS_*` Expo error if the phone key cannot be prepared
   * @throws a standard Expo error if data-directory setup fails
   */
  start(configJson: string): Promise<string>;
  /**
   * One `MobileCall`: its `method` tag and its `args` as JSON (`"null"` for
   * none). Resolves to the call's envelope.
   */
  call(method: string, argsJson: string): Promise<string>;
  /**
   * While enabled (the app lock is on), a native blur covers the window when
   * the app resigns active, so the app switcher snapshot shows no data.
   */
  setSnapshotCover(enabled: boolean): void;
}

/** A failure of the Swift side itself, never of the Rust core. */
export type NativeModuleErrorKind =
  | "keychain"
  | "secureEnclave"
  | "camera"
  | "localNetwork";

/** A typed module error, parsed from a rejected native call. */
export interface NativeModuleError {
  kind: NativeModuleErrorKind;
  /** The `OSStatus` the failing Security or Network call returned. */
  osStatus: number | null;
  message: string;
}
