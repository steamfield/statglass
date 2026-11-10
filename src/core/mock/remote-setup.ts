import type { RemoteHostConfig } from "@core/generated/bindings";
import { fail, ok } from "./protocol";
import type { MockRemotes } from "./remote";
import { APP_VERSION, isLinuxAlias } from "./remote-linux";

export function savedMacSetup(
  remotes: MockRemotes,
  config: RemoteHostConfig,
  reinstall: string | null
) {
  const alias = config.lan ?? config.tailscale ?? "";
  if (isLinuxAlias(alias))
    return reinstall
      ? fail({
          kind: "remote_identity",
          message:
            "A Linux host answered where a Mac reinstall was requested. Check the SSH aliases; Re-pair the host first",
        })
      : null;
  const reported =
    [...remotes.remotes.values()].find(
      (remote) =>
        remote.record.config.lan === alias ||
        remote.record.config.tailscale === alias
    )?.record.config.id ?? `remote-${alias}`;
  const saved = reported ? remotes.remotes.get(reported) : undefined;
  if (saved && reinstall !== reported)
    return fail({
      kind: "internal",
      message: "This Mac is already in your host list",
    });
  if (!reinstall) return null;
  if (reported !== reinstall)
    return fail({
      kind: "remote_identity",
      message: `This Mac reports a different identity (${reported}) than the requested reinstall (${reinstall}). Re-pair the host first`,
    });
  if (!saved) return fail({ kind: "unknown_host", host: reinstall });
  if (saved.record.os !== "mac_os")
    return fail({
      kind: "remote_identity",
      message:
        "A Mac answered where a Linux host was saved. Re-pair the host first",
    });
  remotes.pushRemoteStatus(reinstall, {
    state: saved.record.config.enabled ? "connected" : "disabled",
    agent_version: APP_VERSION,
    agent_update: { kind: "up_to_date", installed: APP_VERSION },
  });
  return ok(saved.record);
}

export async function setupCancelled(
  setups: Map<string, () => void>,
  delay: number | undefined,
  id: string
) {
  if (!delay) return false;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      setups.delete(id);
      resolve(false);
    }, delay);
    setups.set(id, () => {
      clearTimeout(timer);
      setups.delete(id);
      resolve(true);
    });
  });
}
