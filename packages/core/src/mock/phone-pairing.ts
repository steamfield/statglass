import type {
  CommandError,
  PairedHost,
  PairingFailure,
  PairingPreview,
} from "../generated/types";
import type { CommandResult } from "../transport";
import { MOCK_HOST_ID } from "./fixtures";
import { fail } from "./protocol";

const REASONS: readonly PairingFailure[] = [
  "denied",
  "expired",
  "used",
  "unknown",
  "unavailable",
  "monitoring_off",
  "invalid",
];
const CONNECTION_FAILURES = [
  "host_key_unknown",
  "remote_unreachable",
  "remote_auth",
] as const;

const host: PairedHost = {
  id: MOCK_HOST_ID,
  name: "MacBook Pro",
  offered: [],
  unavailable: [],
};

function outcome(text: string): CommandResult<PairedHost> {
  const scenario = text.trim().startsWith("SGPDEMO:")
    ? text.trim().slice(8)
    : "";
  if (scenario === "approve") return { status: "ok", data: host };
  const connection = CONNECTION_FAILURES.find((kind) => kind === scenario);
  if (connection) return fail({ kind: connection, message: "" });
  return fail({
    kind: "pairing",
    reason: REASONS.find((reason) => reason === scenario) ?? "invalid",
    message: "",
  });
}

export function createMockPhonePairing({
  now = Date.now,
}: {
  now?: () => number;
} = {}) {
  const pending: (() => void)[] = [];
  return {
    async previewPairing(text: string): Promise<CommandResult<PairingPreview>> {
      const result = outcome(text);
      const error: CommandError | null =
        result.status === "error" ? result.error : null;
      if (error?.kind === "pairing" && error.reason === "invalid")
        return fail(error);
      return {
        status: "ok",
        data: {
          host_id: host.id,
          name: host.name,
          os: "macOS",
          user: "statglass",
          targets: [{ route: "lan", host: "studio.local" }],
          code: "ABC123",
          expires_ms: now() + 60_000,
          can_hand_over: false,
        },
      };
    },
    pair(
      text: string,
      _deviceName: string,
      _model: string
    ): Promise<CommandResult<PairedHost>> {
      return new Promise((resolve) => {
        pending.push(() => resolve(outcome(text)));
      });
    },
    tick(): void {
      for (const reply of pending.splice(0)) reply();
    },
  };
}
