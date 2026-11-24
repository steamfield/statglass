import type { MockRemotes } from "./remote";

/** Mirror Rust's job clearing and peer removal when a host leaves a run. */
export function syncRrJobs(remotes: MockRemotes) {
  const active = new Set<string>();
  for (const { record } of remotes.remotes.values()) {
    if (
      record.config.enabled &&
      record.status.state === "connected" &&
      record.status.rr
    )
      active.add(record.config.id);
    else record.status.rr = null;
  }
  for (const { record } of remotes.remotes.values()) {
    if (record.status.rr)
      record.status.rr = {
        ...record.status.rr,
        peers: record.status.rr.peers.filter((id) => active.has(id)),
      };
  }
}
