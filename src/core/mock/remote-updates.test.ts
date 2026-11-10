import { createMockTransport } from "@core/mock-transport";

it("walks update phases through status pushes, then reports the target on reconnect", async () => {
  vi.useFakeTimers();
  const transport = createMockTransport({
    scenarios: ["host-updating"],
    historyRows: 1,
  });
  const kinds: string[] = [];
  const read = async () => {
    const host = (await transport.listRemoteHosts())[0];
    if (!host) throw new Error("Missing updating host");
    kinds.push(host.status.update?.phase.kind ?? "connected");
    return host;
  };
  const unlisten = transport.onRemoteHostsChanged(() => {
    void read();
  });
  try {
    const before = await read();
    expect(before.status.vitals.memory_pressure?.kind).toBe("stall");
    await vi.advanceTimersByTimeAsync(10_500);
    expect(kinds).toEqual([
      "queued",
      "probing",
      "uploading",
      "uploading",
      "installing",
      "restarting",
      "reconnecting",
      "connected",
    ]);
    const after = await read();
    expect(after.status.update).toBeNull();
    expect(after.status.last_update_failure).toBeNull();
    expect(after.status.agent_update.kind).toBe("up_to_date");
    expect(after.status.agent_version).toBe(before.status.update?.target);
  } finally {
    unlisten();
    transport.dispose();
    vi.useRealTimers();
  }
});

it("provides six dashboard hosts including disk-low, partial and offline facts", async () => {
  const transport = createMockTransport({
    scenarios: ["hosts-dashboard"],
    historyRows: 1,
  });
  try {
    expect(await transport.listHosts()).toHaveLength(6);
    const hosts = await transport.listRemoteHosts();
    expect(hosts.some((host) => host.status.state === "offline")).toBe(true);
    expect(hosts.some((host) => host.status.vitals.disk_low)).toBe(true);
    expect(
      hosts.some(
        (host) =>
          host.status.vitals.load_1m === null &&
          host.status.vitals.net_rx_bps !== null
      )
    ).toBe(true);
    expect(
      hosts.every(
        (host) =>
          host.status.update === null &&
          host.status.last_update_failure === null
      )
    ).toBe(true);
  } finally {
    transport.dispose();
  }
});

it("retains a failed update without claiming it is still running", async () => {
  const transport = createMockTransport({
    scenarios: ["host-update-failed"],
    historyRows: 1,
  });
  try {
    const host = (await transport.listRemoteHosts())[0];
    expect(host?.status.update).toBeNull();
    expect(host?.status.last_update_failure?.message).toContain(
      "three minutes"
    );
  } finally {
    transport.dispose();
  }
});

it("never invents measured vitals for a host that has never connected", async () => {
  const transport = createMockTransport({
    scenarios: ["host-unreachable"],
    historyRows: 1,
  });
  try {
    const host = (await transport.listRemoteHosts())[0];
    if (!host) throw new Error("Missing unreachable host");
    const expected = {
      cores: 8,
      load_1m: null,
      memory_pressure: null,
      disk_used_bytes: null,
      disk_free_bytes: null,
      disk_total_bytes: null,
      disk_low: false,
      net_rx_bps: null,
      net_tx_bps: null,
    };
    expect(host.status.last_seen_ms).toBeNull();
    expect(host.status.vitals).toEqual(expected);
    expect(await transport.hostVitals(host.config.id)).toEqual({
      status: "ok",
      data: expected,
    });
  } finally {
    transport.dispose();
  }
});
