import type {
  CommandError,
  IncompatibleSide,
  RemoteHostRecord,
  RemoteHostStatus,
} from "./generated/types";

export type Tone = "live" | "muted" | "warning";

export type PhoneRemoteHostStatus = RemoteHostStatus & {
  incompatible_side?: IncompatibleSide | null;
  open_error?: CommandError | null;
};

export type PhoneRemoteHostRecord = Omit<
  RemoteHostRecord,
  "config" | "status"
> & {
  config: Omit<RemoteHostRecord["config"], "mirror_budget_mb">;
  status: PhoneRemoteHostStatus;
};

export type PhoneProblemKind =
  | "key_not_accepted"
  | "no_longer_authorized"
  | "host_key_changed"
  | "identity_changed"
  | "update_host"
  | "update_app"
  | "incompatible"
  | "app_not_running"
  | "monitoring_off"
  | "agent_not_running"
  | "tailscale_down"
  | "local_network"
  | "name_not_resolved"
  | "timeout"
  | "refused"
  | "unreachable"
  | "local_offline"
  | "offline"
  | "phone_key_unavailable"
  | "internal";
export type PhoneAction =
  | "retry"
  | "re_pair"
  | "open_settings"
  | "open_tailscale";
export interface PhoneProblem {
  kind: PhoneProblemKind;
  title: string;
  short: string;
  recovery: string;
  action: PhoneAction | null;
  tone: Tone;
}

export function phoneProblem(
  _record: PhoneRemoteHostRecord,
  _nowMs: number
): PhoneProblem | null {
  return null;
}

export function hostStatusSummary(
  _status: RemoteHostStatus | null,
  _opts: { nowMs: number }
): { label: string; tone: Tone; stale: boolean } {
  return { label: "", tone: "muted", stale: false };
}
