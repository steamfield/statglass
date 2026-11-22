/**
 * The Hosts page's single notice while this Mac is offline, in place of a
 * per-card explanation on every host that waits for the network.
 */
import type { RemoteHostRecord } from "@core/generated/bindings";
import { InlineMessage } from "~/components/inline-message";

/** Shows one note when any remote host is waiting for this Mac's network; nothing otherwise. */
export function HostsOfflineNotice({
  remotes,
}: {
  remotes: readonly RemoteHostRecord[];
}) {
  if (!remotes.some((remote) => remote.status.waiting_for_network)) return null;
  return (
    <InlineMessage tone="note">
      This Mac is offline. Hosts reconnect on their own when the network is
      back.
    </InlineMessage>
  );
}
