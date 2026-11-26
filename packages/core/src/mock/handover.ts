import type {
  DeviceIntentInfo,
  HandoverOffer,
  PairingStatus,
} from "../generated/types";
import type { Transport } from "../transport";
import type { MockCommands } from "./commands";
import { ok } from "./protocol";

// Credential-free QR fixture for the browser demo.
const text = "SGB1:DEMO";
const modules = [
  "111111100101001111111",
  "100000101001001000001",
  "101110101010001011101",
  "101110101100001011101",
  "101110100010101011101",
  "100000100111001000001",
  "111111101010101111111",
  "000000001110000000000",
  "100000101001011001110",
  "010011011101110010101",
  "010100111000101101011",
  "001110011011111001011",
  "001001110101111111000",
  "000000001110100000100",
  "111111100101010101111",
  "100000100100001101001",
  "101110100001010101010",
  "101110100101111010100",
  "101110100111110011011",
  "100000100101111001101",
  "111111101110100001100",
];
const qrPath = modules
  .flatMap((row, y) =>
    Array.from(row, (cell, x) =>
      cell === "1" ? `M${x + 4} ${y + 4}h1v1h-1z` : ""
    )
  )
  .join("");
const qrSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29"><path d="M0 0h29v29H0z"/><path d="${qrPath}"/></svg>`;

const BUILD_SERVER = "a0b00000-0000-4000-8000-000000000001";
const LAB_MINI = "a0b00000-0000-4000-8000-000000000002";
const OFFICE_SERVER = "a0b00000-0000-4000-8000-000000000003";
const offeredHosts = [
  [BUILD_SERVER, "build-server"],
  [LAB_MINI, "Lab Mini"],
] as const;

export function createMockHandover(
  commands: MockCommands,
  now: () => number = Date.now
): Pick<
  Transport,
  "handoverBundleStart" | "deviceIntents" | "retryDeviceIntents"
> & {
  onApprove: (
    device: string
  ) => Pick<
    Extract<PairingStatus, { kind: "paired" }>,
    "hosts" | "unavailable" | "dropped"
  >;
  onRevoke: (device: string) => void;
} {
  let intents: DeviceIntentInfo[] = [
    {
      host: BUILD_SERVER,
      host_name: "build-server",
      device: "A1B2C3",
      device_name: "iPhone A1B2C3",
      op: "revoke",
      state: "failed",
      reason: "Host is offline.",
      attempts: 1,
    },
    {
      host: LAB_MINI,
      host_name: "Lab Mini",
      device: "7F3A2C",
      device_name: "iPhone 7F3A2C",
      op: "install",
      state: "pending",
      reason: null,
      attempts: 0,
    },
  ];
  const authorized = new Map<string, Set<string>>([
    ["7F3A2C", new Set([BUILD_SERVER, LAB_MINI])],
  ]);
  const queue = (intent: DeviceIntentInfo) => {
    intents = intents.filter(
      (existing) =>
        existing.host !== intent.host || existing.device !== intent.device
    );
    intents.push(intent);
  };
  const changeAccess = (
    host: string,
    host_name: string,
    device: string,
    op: "install" | "revoke"
  ) => {
    queue({
      host,
      host_name,
      device,
      device_name: `iPhone ${device}`,
      op,
      state: "pending",
      reason: null,
      attempts: 0,
    });
  };
  const provision = (device: string) => {
    const installed = authorized.get(device) ?? new Set<string>();
    for (const [host, name] of offeredHosts) {
      if (installed.has(host)) continue;
      installed.add(host);
      changeAccess(host, name, device, "install");
    }
    authorized.set(device, installed);
  };
  return {
    onApprove(device) {
      provision(device);
      return {
        hosts: offeredHosts.map(([, name]) => name),
        unavailable: [
          { id: OFFICE_SERVER, name: "Office server", reason: "proxy_jump" },
        ],
        dropped: false,
      };
    },
    onRevoke(device) {
      const installed = authorized.get(device);
      if (!installed) return;
      for (const [host, name] of offeredHosts) {
        if (installed.has(host)) changeAccess(host, name, device, "revoke");
      }
      authorized.delete(device);
    },
    async handoverBundleStart() {
      commands.record("handover_bundle_start");
      for (const device of authorized.keys()) provision(device);
      return ok<HandoverOffer>({
        text,
        qr_svg: qrSvg,
        hosts: offeredHosts.map(([, name]) => name),
        unavailable: [
          { id: OFFICE_SERVER, name: "Office server", reason: "proxy_jump" },
        ],
        issued_ms: now(),
      });
    },
    async deviceIntents() {
      commands.record("device_intents");
      return ok(intents.map((intent) => ({ ...intent })));
    },
    async retryDeviceIntents() {
      commands.record("retry_device_intents");
      intents = intents
        .filter((intent) => intent.host === BUILD_SERVER)
        .map((intent) => ({
          ...intent,
          state: "failed",
          reason: "Host is offline.",
          attempts: intent.attempts + 1,
        }));
      return ok(null);
    },
  };
}
