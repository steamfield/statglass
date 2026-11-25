import type { Transport } from "@core/transport";
import { commands } from "@desktop/commands";

export function nativeHandover(): Pick<
  Transport,
  "handoverBundleStart" | "deviceIntents" | "retryDeviceIntents"
> {
  return {
    handoverBundleStart: () => commands.handoverBundleStart(),
    deviceIntents: () => commands.deviceIntents(),
    retryDeviceIntents: () => commands.retryDeviceIntents(),
  };
}
