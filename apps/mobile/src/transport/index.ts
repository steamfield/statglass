/** The phone's real transport over the native Rust core (phase 4). */
export { nativeBuildInfo, protocolRangeText } from "./build-info";
export { parseEnvelope } from "./envelope";
export { createLiveStreams, type LiveStreams } from "./live-streams";
export { NativeCoreBridge } from "./native-core-bridge";
export {
  createNativeTransport,
  isNativeTransport,
  type NativeTransport,
  startNativeTransport,
} from "./native-transport";
export { toRemoteHostRecord } from "./remote-hosts";
