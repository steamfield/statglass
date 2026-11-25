/**
 * The app's open live streams on the native core: picks each stream's id,
 * routes `onLive` payloads to its callback in arrival order, and ends
 * streams on unsubscribe.
 */
import type {
  CommandError,
  HostId,
  LiveMsg,
  SubscriptionInfo,
} from "@core/generated/types";
import type { LiveOptions, LiveSubscription } from "@core/transport";
import type { StatglassNativeModule } from "@native/statglass-native";
import { callCore } from "./envelope";

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

// One core broadcasts one stream id space, even when JS replaces a transport.
const nextStreamIds = new WeakMap<StatglassNativeModule, number>();

/** Streams over `native`, listening to its `onLive` event. */
export function createLiveStreams(native: StatglassNativeModule): LiveStreams {
  const streams = new Map<
    number,
    { onMsg: (msg: LiveMsg) => void; subscribed: boolean }
  >();
  let listener: ReturnType<StatglassNativeModule["addListener"]> | undefined;
  let disposed = false;
  const closed: CommandError = {
    kind: "internal",
    message: "The live transport was disposed.",
  };

  async function endStream(stream: number) {
    try {
      const result = await callCore<null>(native, {
        method: "unsubscribe_live",
        args: { stream },
      });
      if (result.status === "error") throw result.error;
    } catch (error) {
      console.warn("[native core] could not end live stream", {
        stream,
        error,
      });
    }
  }

  function forget(stream: number) {
    streams.delete(stream);
    if (streams.size === 0) {
      listener?.remove();
      listener = undefined;
    }
  }

  return {
    async open(host, onMsg, options) {
      if (disposed) throw closed;
      const stream = nextStreamIds.get(native) ?? 1;
      nextStreamIds.set(native, stream + 1);
      const entry = { onMsg, subscribed: false };
      streams.set(stream, entry);

      try {
        listener ??= native.addListener("onLive", ({ stream: id, message }) => {
          streams.get(id)?.onMsg(JSON.parse(message) as LiveMsg);
        });
        const info = await callCore<SubscriptionInfo>(native, {
          method: "subscribe_live",
          args: {
            host,
            stream,
            backfill_ms: options?.backfillMs ?? null,
            series: options?.series?.slice() ?? null,
            min_period_ms: options?.minPeriodMs ?? null,
          },
        });
        if (info.status === "error") throw info.error;
        if (disposed) {
          // The core might have registered the stream after dispose ran.
          await endStream(stream);
          throw closed;
        }
        entry.subscribed = true;
        return {
          info,
          unsubscribe() {
            if (!streams.has(stream)) return;
            forget(stream);
            void endStream(stream);
          },
        };
      } catch (error) {
        forget(stream);
        throw error;
      }
    },
    dispose() {
      disposed = true;
      listener?.remove();
      listener = undefined;
      for (const [stream, { subscribed }] of streams) {
        if (subscribed) void endStream(stream);
      }
      streams.clear();
    },
  };
}
