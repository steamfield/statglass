import type { HostId, RemoteHostStatus } from "./generated/types";
import type { LiveOptions as LiveRequest, Transport } from "./transport";

export interface LiveSessionDeps<S> {
  subscribe: Transport["subscribeLive"];
  apply(state: S): void;
  clock: {
    now(): number;
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  };
  visible(): boolean;
  onVisible(listener: (visible: boolean) => void): () => void;
  status(): RemoteHostStatus | null;
}

export function createLiveSession<S>(
  _host: HostId,
  _request: LiveRequest,
  _deps: LiveSessionDeps<S>
): { stop(): void; retry(): void } {
  return { stop() {}, retry() {} };
}
