import { bytesParts, formatBytes } from "@core/format";
import type {
  LinuxPreparation,
  RemoteHostRecord,
  UpdatePhase,
  UpdateStatus,
} from "@core/generated/bindings";

export function connectionLabel(remote: RemoteHostRecord): string {
  const { status } = remote;
  if (status.state === "connected")
    return `${status.route === "lan" ? "LAN" : "Tailscale"}${status.sync === "catching_up" ? " · catching up history" : status.sync === "unavailable" ? " · history unavailable" : " · connected"}`;
  return (
    {
      connecting: "Connecting…",
      offline: "Offline",
      disabled: "Connection disabled",
      error: "Connection failed",
    }[status.state] ?? status.state
  );
}

/** What the probe found on a Linux host: "Linux 6.17 · aarch64 · systemd 256". */
export function linuxSystemLine(linux: LinuxPreparation): string {
  const kernel = linux.kernel?.match(/^\d+\.\d+/)?.[0];
  return [
    kernel ? `Linux ${kernel}` : "Linux",
    linux.arch,
    linux.systemd_version === null ? null : `systemd ${linux.systemd_version}`,
  ]
    .filter((part) => part)
    .join(" · ");
}

/**
 * Hosts this Mac can bring up to its own version (D-123). A host the user
 * switched off isn't counted: nothing is asked of it until it's back on.
 */
export function hostsNeedingUpdate(
  remotes: readonly RemoteHostRecord[]
): RemoteHostRecord[] {
  return remotes.filter(
    (r) =>
      r.config.enabled &&
      (r.status.agent_update.kind === "available" ||
        r.status.agent_update.kind === "required")
  );
}

/**
 * The version this Mac is about to move to, when its own update is under way.
 * The updater only reports a version for a release newer than this build, so
 * no comparison is needed here.
 */
export function localUpdateTarget(status: UpdateStatus | null): string | null {
  switch (status?.kind) {
    case "available":
    case "downloading":
    case "downloaded":
    case "waiting":
    case "needs_authorization":
    case "installing":
    case "ready":
      return status.version;
    default:
      return null;
  }
}

export interface HostVersionState {
  kind:
    | "latest"
    | "newer"
    | "available"
    | "required"
    | "updating"
    | "failed"
    | "unknown";
  text: string;
  icon: "check" | "up" | "error" | null;
  target: string | null;
  notes: string | null;
  action: { kind: "push" | "add_host" | "settings"; label: string } | null;
  progress: UpdatePhase | null;
}

export function updatePhaseText(phase: UpdatePhase): string {
  switch (phase.kind) {
    case "queued":
      return "Waiting for another update";
    case "probing":
      return "Checking the host";
    case "uploading": {
      const sent = bytesParts(phase.sent_bytes, { unit: "MB" });
      return `Uploading ${sent.value} of ${formatBytes(phase.total_bytes, { unit: "MB" })}`;
    }
    case "installing":
      return "Installing";
    case "restarting":
      return "Restarting";
    case "reconnecting":
      return "Reconnecting";
    case "unknown":
      return "Updating";
  }
}

/** One source for card and settings version copy, with Rust progress taking precedence. */
export function agentVersionState(remote: RemoteHostRecord): HostVersionState {
  const { status, config } = remote;
  const update = status.agent_update;
  const allowed = config.enabled && status.identity_changed === null;
  const reachable =
    allowed && (status.state === "connected" || update.kind === "required");
  const via =
    status.last_update_failure?.via ?? ("via" in update ? update.via : null);
  const action = (
    label: string,
    canRun = reachable
  ): HostVersionState["action"] =>
    canRun && via ? { kind: via, label } : null;
  const base: HostVersionState = {
    kind: "unknown",
    text: "Version not reported yet",
    icon: null,
    target: null,
    notes: null,
    action: null,
    progress: null,
  };
  if (status.update)
    return {
      ...base,
      kind: "updating",
      target: status.update.target,
      text: `Updating to ${status.update.target} · ${updatePhaseText(status.update.phase)}`,
      progress: status.update.phase,
    };
  if (status.last_update_failure)
    return {
      ...base,
      kind: "failed",
      icon: "error",
      target: status.last_update_failure.target,
      text: `Update to ${status.last_update_failure.target} failed`,
      action: action("Retry update", allowed),
    };
  if (update.kind === "unknown") return base;
  const installed = `StatGlass ${update.installed}`;
  switch (update.kind) {
    case "up_to_date":
      return {
        ...base,
        kind: "latest",
        text: `${installed} · Latest`,
        icon: "check",
      };
    case "newer_than_this":
      return {
        ...base,
        kind: "newer",
        text: `${installed} · Newer than this Mac`,
      };
    case "required":
      return {
        ...base,
        kind: "required",
        text: `Needs ${update.target} to connect`,
        target: update.target,
        notes: releaseUrl(update.target),
        action: action(
          update.via === "push"
            ? `Update to ${update.target}`
            : `Reinstall ${update.target}…`
        ),
      };
    case "available":
      return {
        ...base,
        kind: "available",
        icon: "up",
        target: update.target,
        notes: releaseUrl(update.target),
        text: `${installed} · ${update.target} available${status.state === "connected" ? "" : ", updates once reachable"}`,
        action: action(
          update.via === "push"
            ? `Update to ${update.target}`
            : `Reinstall ${update.target}…`
        ),
      };
  }
}

export function localVersionState(
  version: string,
  target: string | null
): HostVersionState {
  return {
    kind: target ? "available" : "latest",
    text: `StatGlass ${version} · ${target ? `${target} available` : "Latest"}`,
    icon: target ? "up" : "check",
    target,
    notes: target ? releaseUrl(target) : null,
    action: target ? { kind: "settings", label: "Update" } : null,
    progress: null,
  };
}

/** The legacy line shares the same version state and copy as host cards. */
export function agentVersionLine(
  remote: RemoteHostRecord,
  localTarget: string | null
): { text: string; tone: "muted" | "destructive" } {
  const state = agentVersionState(remote);
  return {
    text:
      state.text +
      (localTarget ? ` · ${localTarget} after updating this Mac` : ""),
    tone:
      state.kind === "failed" || state.kind === "required"
        ? "destructive"
        : "muted",
  };
}

/** A release page link, only for a plain version the opener scope allows. */
export function releaseUrl(version: string): string | null {
  return /^\d+\.\d+\.\d+$/.test(version)
    ? `https://github.com/steamfield/statglass/releases/tag/v${version}`
    : null;
}

export type HostUpdateNotice =
  | { kind: "required"; count: number }
  | { kind: "local_first"; version: string; key: string }
  | { kind: "local_restart"; version: string; key: string }
  | { kind: "hosts"; count: number; key: string };

/**
 * The dashboard notice (D-123). A host that can't connect always shows. When
 * this Mac has its own newer release on the way, that comes first: pushing
 * the current agent now would be repeated after the restart. Dismissing hides
 * a notice until its version changes.
 */
export function hostUpdateNotice(
  remotes: readonly RemoteHostRecord[],
  local: UpdateStatus | null,
  dismissed: string | null
): HostUpdateNotice | null {
  const behind = hostsNeedingUpdate(remotes);
  if (behind.length === 0) return null;
  const required = behind.filter(
    (r) => r.status.agent_update.kind === "required"
  ).length;
  if (required > 0) return { kind: "required", count: required };
  const first = behind[0]?.status.agent_update;
  const hostTarget = first && "target" in first ? first.target : "";
  const target = localUpdateTarget(local);
  const notice: HostUpdateNotice =
    target === null
      ? {
          kind: "hosts",
          count: behind.length,
          key: `hosts:${hostTarget}`,
        }
      : local?.kind === "installing" || local?.kind === "ready"
        ? { kind: "local_restart", version: target, key: `local:${target}` }
        : { kind: "local_first", version: target, key: `local:${target}` };
  return notice.key === dismissed ? null : notice;
}
