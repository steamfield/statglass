import type { RemoteHostStatus } from "@core/generated/bindings";
import { CLOCK_STEP_THRESHOLD_MS } from "@core/host-clock";
import type { MockRemotes } from "./remote";
import { syncRrJobs } from "./rr";

/** Same rendered fields as the Rust registration gate; live facts use the poll. */
function renderedStatusChanged(
  previous: RemoteHostStatus,
  next: RemoteHostStatus
): boolean {
  const rendered = (status: RemoteHostStatus) => [
    status.state,
    status.route,
    status.error,
    status.sync,
    status.agent_version,
    status.identity_changed,
    status.agent_update,
    status.update,
    status.last_update_failure,
    status.rr,
  ];
  const serialize = (status: RemoteHostStatus) =>
    JSON.stringify(rendered(status), (_key, value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return value;
      return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      );
    });
  return serialize(previous) !== serialize(next);
}

/** Mock source callbacks keep the last emitted clock offset, just as Rust does. */
export class MockRemoteStatus {
  private readonly offsets = new Map<string, number>();

  forget(id: string) {
    this.offsets.delete(id);
  }

  push(
    remotes: MockRemotes,
    id: string,
    status: Partial<RemoteHostStatus>,
    emit: () => void
  ) {
    const remote = remotes.remotes.get(id);
    if (!remote) return;
    const previous = remote.record.status;
    const offset = this.offsets.get(id) ?? previous.clock_offset_ms ?? 0;
    remote.record = { ...remote.record, status: { ...previous, ...status } };
    syncRrJobs(remotes);
    const next = remote.record.status;
    const changed =
      renderedStatusChanged(previous, next) ||
      Math.abs((next.clock_offset_ms ?? 0) - offset) >= CLOCK_STEP_THRESHOLD_MS;
    this.offsets.set(id, changed ? (next.clock_offset_ms ?? 0) : offset);
    if (changed) emit();
  }
}
