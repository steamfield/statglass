import type { Transport } from "../transport";
import type { MockCommands } from "./commands";
import { fail, ok } from "./protocol";

export function createMockHandover(
  commands: MockCommands
): Pick<
  Transport,
  "handoverBundleStart" | "deviceIntents" | "retryDeviceIntents"
> {
  return {
    async handoverBundleStart() {
      commands.record("handover_bundle_start");
      return fail({
        kind: "handover",
        message: "Host handover is not implemented.",
      });
    },
    async deviceIntents() {
      commands.record("device_intents");
      return ok([]);
    },
    async retryDeviceIntents() {
      commands.record("retry_device_intents");
      return ok(null);
    },
  };
}
