import type {
  PairedDeviceInfo,
  PairingOffer,
  PairingStatus,
} from "@core/generated/types";
import type { Transport } from "../transport";
import type { MockCommands } from "./commands";
import { fail, ok } from "./protocol";

const CODE = "K7M2RX";
const TTL_MS = 600_000;
const SCAN_MS = 3_000;
const DEMO_TEXT = "SGP1:DEMO";

// QR for DEMO_TEXT. The browser fixture carries no pairing credentials.
const QR_MODULES = [
  "111111101000101111111",
  "100000100010101000001",
  "101110100001101011101",
  "101110100010101011101",
  "101110100101101011101",
  "100000100110001000001",
  "111111101010101111111",
  "000000001000000000000",
  "110110100011001000001",
  "100111010001110011101",
  "111101111111111000011",
  "001010011100110110111",
  "010101111111111010111",
  "000000001000100000101",
  "111111100101001010100",
  "100000100110001010111",
  "101110101110001000000",
  "101110101110111011100",
  "101110100011110010111",
  "100000101101100010111",
  "111111101100110101000",
];
const qrPath = QR_MODULES.flatMap((row, y) =>
  Array.from(row, (cell, x) =>
    cell === "1" ? `M${x + 4} ${y + 4}h1v1h-1z` : ""
  )
).join("");
const qrSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29"><path d="M0 0h29v29H0z"/><path d="${qrPath}"/></svg>`;

const PHONE: PairedDeviceInfo = {
  tag: "D4A910",
  name: "Travel iPhone",
  fingerprint: "SHA256:2YrVFQXmYPCgiMi9xH2S8tG9YV+zQhaordpy0MpVVeY",
  last_seen_ms: null,
};

type MockOffer = { offer: PairingOffer; status: PairingStatus };

function currentStatus(entry: MockOffer, enabled = true): PairingStatus {
  const { status, offer } = entry;
  if (status.kind !== "waiting" && status.kind !== "pending") return status;
  const now = Date.now();
  if (now >= offer.expires_ms) return { kind: "expired" };
  if (!enabled) {
    entry.status = { kind: "failed", message: MONITORING_OFF };
    return entry.status;
  }
  return now >= offer.expires_ms - TTL_MS + SCAN_MS
    ? {
        kind: "pending",
        device_name: PHONE.name,
        model: "iPhone 16",
        code: CODE,
      }
    : { kind: "waiting" };
}

const pairingFailure = (message: string) => fail({ kind: "pairing", message });
const MONITORING_OFF =
  "Turn on Allow remote monitoring in StatGlass Settings, then try pairing again.";

async function monitoringEnabled(transport: Pick<Transport, "getSettings">) {
  return (
    (await transport.getSettings()).settings.remote_access?.enabled ?? false
  );
}

/** Settings and the pairing demo share the per-window mock transport. */
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
  const offers = new Map<string, MockOffer>();
  const devices = new Map<string, PairedDeviceInfo>([
    [
      "7F3A2C",
      {
        tag: "7F3A2C",
        name: "Home iPhone",
        fingerprint: "SHA256:UoP7jm1c8pYse5QlaRgkaSL/n9TVa5EDMbvGX5Qd98U",
        last_seen_ms: Date.now() - 7_200_000,
      },
    ],
  ]);
  let nextNonce = 0;
  const deny = (nonce: string, command: string) => {
    commands.record(command, nonce);
    const entry = offers.get(nonce);
    if (!entry) return pairingFailure("Unknown pairing offer.");
    const status = currentStatus(entry);
    entry.status =
      status.kind === "waiting" || status.kind === "pending"
        ? { kind: "denied" }
        : status;
    return ok(null);
  };
  return {
    async pairingStart(this: Pick<Transport, "getSettings">) {
      commands.record("pairing_start");
      if (!(await monitoringEnabled(this)))
        return pairingFailure(MONITORING_OFF);
      const nonce = (++nextNonce).toString(16).padStart(32, "0");
      const offer = {
        nonce,
        code: CODE,
        expires_ms: Date.now() + TTL_MS,
        qr_svg: qrSvg,
        text: DEMO_TEXT,
      };
      offers.set(nonce, { offer, status: { kind: "waiting" } });
      return ok(offer);
    },
    async pairingStatus(this: Pick<Transport, "getSettings">, nonce) {
      commands.record("pairing_status", nonce);
      const entry = offers.get(nonce);
      if (!entry)
        return ok({ kind: "failed", message: "Unknown pairing offer." });
      return ok(currentStatus(entry, await monitoringEnabled(this)));
    },
    async pairingApprove(this: Pick<Transport, "getSettings">, nonce) {
      commands.record("pairing_approve", nonce);
      const entry = offers.get(nonce);
      if (!entry) return pairingFailure("Unknown pairing offer.");
      const status = currentStatus(entry, await monitoringEnabled(this));
      if (status.kind === "waiting")
        return pairingFailure("No iPhone is waiting for approval.");
      if (status.kind !== "pending") return ok(status);
      if (!devices.has(PHONE.tag)) devices.set(PHONE.tag, PHONE);
      entry.status = { kind: "paired", device: PHONE.tag };
      return ok(entry.status);
    },
    pairingDeny: async (nonce) => deny(nonce, "pairing_deny"),
    pairingCancel: async (nonce) => deny(nonce, "pairing_cancel"),
    pairedDevices: async () => {
      commands.record("paired_devices");
      return ok([...devices.values()]);
    },
    revokeDevice: async (tag) => {
      commands.record("revoke_device", tag);
      if (!/^[0-9A-F]{6}$/.test(tag))
        return pairingFailure("Invalid paired device tag.");
      return ok(devices.delete(tag));
    },
  };
}
