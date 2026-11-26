import type { RemoteHostConfig } from "@core/generated/types";
import { fail } from "./protocol";
import type { MockRemotes } from "./remote";
import { isLinuxAlias } from "./remote-linux";

/** A Mac already in the host list is never added twice, as native setup refuses. */
export function savedMacSetup(remotes: MockRemotes, config: RemoteHostConfig) {
  const alias = config.lan ?? config.tailscale ?? "";
  if (isLinuxAlias(alias)) return null;
  const saved = [...remotes.remotes.values()].some(
    (remote) =>
      remote.record.config.lan === alias ||
      remote.record.config.tailscale === alias
  );
  return saved
    ? fail({
        kind: "internal",
        message: "This Mac is already in your host list",
      })
    : null;
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
