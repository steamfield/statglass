import type { PairedHost, PairingPreview } from "@core/generated/types";
import type { CommandResult } from "@core/transport";

export interface PhonePairing {
  previewPairing(text: string): Promise<CommandResult<PairingPreview>>;
  pair(
    text: string,
    deviceName: string,
    model: string
  ): Promise<CommandResult<PairedHost>>;
}
