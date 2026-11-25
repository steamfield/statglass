/**
 * The app's open live streams on the native core: picks each stream's id,
 * routes `onLive` payloads to its callback in arrival order, and ends
 * streams on unsubscribe.
 */
import type { HostId, LiveMsg } from "@core/generated/types";
import type { LiveOptions, LiveSubscription } from "@core/transport";
import type { StatglassNativeModule } from "@native/statglass-native";

/** Every live stream open on one native core. */
export interface LiveStreams {
  /** `subscribeLive` for {@link createNativeTransport}. */
  open(
    host: HostId,
    onMsg: (msg: LiveMsg) => void,
    options?: LiveOptions
  ): Promise<LiveSubscription>;
  /** Stops listening to the module and ends every stream. */
  dispose(): void;
}

/** Streams over `native`, listening to its `onLive` event. */
export function createLiveStreams(native: StatglassNativeModule): LiveStreams {
  void native;
  throw new Error("createLiveStreams: not implemented (phase 4 lane c)");
}
