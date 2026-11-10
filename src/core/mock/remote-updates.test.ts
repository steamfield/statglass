import type { HistoryRequest } from "@core/generated/bindings";
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

it("rejects saved Mac identities as native setup does", async () => {
  const transport = createMockTransport({
    scenarios: ["hosts-outdated"],
    autoTick: false,
  });
  try {
    const mac = (await transport.listRemoteHosts()).find(
      (host) => host.os === "mac_os"
    );
    if (!mac) throw new Error("Missing Mac fixture");
    const result = await transport.addRemoteHost(
      mac.config,
      true,
      true,
      "reinstall-attempt"
    );
    expect(result).toEqual({
      status: "error",
      error: {
        kind: "internal",
        message: "This Mac is already in your host list",
      },
    });
  } finally {
    transport.dispose();
  }
});

it("reinstalls only the requested saved Mac and keeps its configuration and mirrored history", async () => {
  const transport = createMockTransport({
    scenarios: ["hosts-outdated"],
    historyRows: 10,
  });
  try {
    const mac = (await transport.listRemoteHosts()).find(
      (host) => host.os === "mac_os"
    );
    if (!mac) throw new Error("Missing Mac fixture");
    const config = { ...mac.config, mirror_budget_mb: 731, enabled: false };
    await transport.updateRemoteHost(config);
    const before = await transport.historySize(config.id);
    const result = await transport.addRemoteHost(
      {
        ...config,
        name: "Unwanted rename",
        mirror_budget_mb: 10,
        enabled: true,
      },
      true,
      true,
      "same-id",
      config.id
    );
    expect(result).toMatchObject({
      status: "ok",
      data: {
        config,
        status: { state: "disabled", agent_update: { kind: "up_to_date" } },
      },
    });
    expect(await transport.historySize(config.id)).toEqual(before);
    expect(await transport.listRemoteHosts()).toHaveLength(4);
  } finally {
    transport.dispose();
  }
});

it("retains accumulated mirrored samples through a Mac reinstall", async () => {
  vi.useFakeTimers();
  const transport = createMockTransport({
    scenarios: ["hosts-outdated"],
    historyRows: 1,
    autoTick: true,
  });
  try {
    const mac = (await transport.listRemoteHosts()).find(
      (host) => host.os === "mac_os"
    );
    if (!mac) throw new Error("Missing Mac fixture");
    const subscription = await transport.subscribeLive(mac.config.id, () => {});
    try {
      await vi.advanceTimersByTimeAsync(30000);
      const to = Date.now() + (mac.status.clock_offset_ms ?? 0);
      const request: HistoryRequest = {
        host: mac.config.id,
        selectors: [{ metric: "cpu.total", labels: [] }],
        from_ms: to - 60000,
        to_ms: to,
        tier: "s10",
        max_points: 61,
      };
      const before = await transport.queryHistory(request);
      if (before.status === "error")
        throw new Error("Missing mirrored samples");
      expect(before.data.series[0]?.points.length).toBeGreaterThan(1);
      expect(before).toMatchObject({
        status: "ok",
        data: { series: [{ points: expect.any(Array) }] },
      });
      const result = await transport.addRemoteHost(
        mac.config,
        true,
        true,
        "history-reinstall",
        mac.config.id
      );
      expect(result.status).toBe("ok");
      expect(await transport.queryHistory(request)).toEqual(before);
    } finally {
      subscription.unsubscribe();
    }
  } finally {
    transport.dispose();
    vi.useRealTimers();
  }
});

it("rejects a different saved Mac and an unsaved mismatched identity without adding either", async () => {
  const transport = createMockTransport({
    scenarios: ["hosts-outdated"],
    historyRows: 1,
  });
  try {
    const mac = (await transport.listRemoteHosts()).find(
      (host) => host.os === "mac_os"
    );
    if (!mac) throw new Error("Missing Mac fixture");
    const before = await transport.listRemoteHosts();
    expect(
      await transport.addRemoteHost(
        mac.config,
        true,
        true,
        "other-saved",
        "different-id"
      )
    ).toEqual({
      status: "error",
      error: {
        kind: "internal",
        message: "This Mac is already in your host list",
      },
    });
    expect(
      await transport.addRemoteHost(
        { ...mac.config, lan: "unknown-mac.local" },
        true,
        true,
        "mismatched",
        mac.config.id
      )
    ).toMatchObject({
      status: "error",
      error: {
        kind: "remote_identity",
        message: expect.stringContaining("different identity"),
      },
    });
    expect(await transport.listRemoteHosts()).toEqual(before);
  } finally {
    transport.dispose();
  }
});
