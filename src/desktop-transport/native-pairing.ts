/**
 * The app transport's phone pairing: the seven `pairing_*` / device commands,
 * straight to the generated bindings (`src-tauri/src/pairing.rs`).
 */
import type { Transport } from "@core/transport/contracts";
import { commands } from "@desktop/commands";

/** The pairing commands of the app transport, spread into `createTauriTransport`. */
export function nativePairing(): Pick<
  Transport,
  | "pairingStart"
  | "pairingStatus"
  | "pairingApprove"
  | "pairingDeny"
  | "pairingCancel"
  | "pairedDevices"
  | "revokeDevice"
> {
  return {
    pairingStart: () => commands.pairingStart(),
    pairingStatus: (nonce) => commands.pairingStatus(nonce),
    pairingApprove: (nonce) => commands.pairingApprove(nonce),
    pairingDeny: (nonce) => commands.pairingDeny(nonce),
    pairingCancel: (nonce) => commands.pairingCancel(nonce),
    pairedDevices: () => commands.pairedDevices(),
    revokeDevice: (tag) => commands.revokeDevice(tag),
  };
}
