/**
 * The mock transport's phone pairing: the seven `pairing_*` / device commands.
 *
 * Scaffold: every command records its call and fails with `pairing` "not
 * implemented", as the Rust stubs do. Phase 5 lane c replaces this with the
 * offer, approval and device-list behavior of `src-tauri/src/pairing.rs`.
 */
import type { Transport } from "../transport";
import type { MockCommands } from "./commands";
import { fail } from "./protocol";

/** The pairing commands of the mock transport, registered by `createMockTransport`. */
export function createMockPairing(
  commands: MockCommands
): Pick<
  Transport,
  | "pairingStart"
  | "pairingStatus"
  | "pairingApprove"
  | "pairingDeny"
  | "pairingCancel"
  | "pairedDevices"
  | "revokeDevice"
> {
  const notImplemented = (command: string, ...args: unknown[]) => {
    commands.record(command, ...args);
    return Promise.resolve(
      fail({ kind: "pairing", message: "not implemented" })
    );
  };
  return {
    pairingStart: () => notImplemented("pairing_start"),
    pairingStatus: (nonce) => notImplemented("pairing_status", nonce),
    pairingApprove: (nonce) => notImplemented("pairing_approve", nonce),
    pairingDeny: (nonce) => notImplemented("pairing_deny", nonce),
    pairingCancel: (nonce) => notImplemented("pairing_cancel", nonce),
    pairedDevices: () => notImplemented("paired_devices"),
    revokeDevice: (tag) => notImplemented("revoke_device", tag),
  };
}
