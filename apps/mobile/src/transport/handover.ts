import type { OfferedHost } from "@core/generated/types";
import type { StatglassNativeModule } from "@native/statglass-native";
import { callCoreByMethod } from "./envelope";
import type { NativeTransport } from "./native-transport";

export function createHandoverCommands(native: StatglassNativeModule) {
  return {
    decodeBundle: (text: string) =>
      callCoreByMethod(native, { method: "decode_bundle", args: { text } }),
    addHandoverHosts: (hosts: OfferedHost[], previewId?: number) =>
      callCoreByMethod(native, {
        method: "add_handover_hosts",
        args: { hosts, preview_id: previewId ?? null },
      }),
  };
}

export function nativeHandover(core: NativeTransport) {
  return core.handover;
}
