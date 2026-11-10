import type { RemoteHostStatus } from "@core/generated/bindings";
import { createMockTransport } from "@core/mock-transport";

it("polls live facts but emits rendered changes and accumulated clock steps", async () => {
  const transport = createMockTransport({
    scenarios: ["multi-host"],
    autoTick: false,
  });
  const changed = vi.fn();
  const stop = transport.onRemoteHostsChanged(changed);
  try {
    const host = (await transport.listRemoteHosts())[0];
    if (!host) throw new Error("Missing remote");
    const { id } = host.config;
    transport.pushRemoteStatus(id, {
      last_seen_ms: 123,
      vitals: { ...host.status.vitals, cpu_pct: 99 },
    });
    expect(changed).not.toHaveBeenCalled();
    const offset = host.status.clock_offset_ms ?? 0;
    const steps: [number, number][] = [
      [400, 0],
      [999, 0],
      [1000, 1],
      [1400, 1],
      [1999, 1],
      [2000, 2],
      [1000, 3],
    ];
    for (const [delta, count] of steps) {
      transport.pushRemoteStatus(id, {
        clock_offset_ms: offset + delta,
      });
      expect(changed).toHaveBeenCalledTimes(count);
    }
    const patches: Partial<RemoteHostStatus>[] = [
      { sync: "catching_up" },
      { agent_version: "different wording" },
      { route: "tailscale" },
      { error: "unavailable" },
      { identity_changed: "another-host" },
      { agent_update: { kind: "unknown" } },
      {
        update: {
          phase: { kind: "probing" },
          target: "1.0.0",
        },
      },
      {
        last_update_failure: {
          message: "failed",
          target: "1.0.0",
          via: "push",
        },
      },
      { state: "offline" },
    ];
    for (const [index, patch] of patches.entries()) {
      transport.pushRemoteStatus(id, patch);
      expect(changed).toHaveBeenCalledTimes(index + 4);
      transport.pushRemoteStatus(id, patch);
      expect(changed).toHaveBeenCalledTimes(index + 4);
    }
    transport.pushRemoteStatus(id, {
      update: { target: "1.0.0", phase: { kind: "probing" } },
    });
    expect(changed).toHaveBeenCalledTimes(patches.length + 3);
  } finally {
    stop();
    transport.dispose();
  }
});
