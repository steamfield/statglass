import type { PairedHost, PairingPreview } from "../generated/types";
import type { CommandResult } from "../transport";
import { fail } from "./protocol";

export function createMockPhonePairing(_options?: { now?: () => number }) {
  return {
    async previewPairing(
      _text: string
    ): Promise<CommandResult<PairingPreview>> {
      return fail({
        kind: "pairing",
        reason: "invalid",
        message: "Invalid pairing code",
      });
    },
    async pair(
      _text: string,
      _deviceName: string,
      _model: string
    ): Promise<CommandResult<PairedHost>> {
      return fail({
        kind: "pairing",
        reason: "invalid",
        message: "Invalid pairing code",
      });
    },
    tick(): void {},
  };
}
