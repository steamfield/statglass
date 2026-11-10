import type {
  AgentUpdate,
  RemoteHostRecord,
  RemoteState,
  UpdatePhase,
} from "@core/generated/bindings";
import { hostRecord, scenarioFlags } from "@core/mock/fixtures";
import { mockHostVitals } from "@core/mock/remote-updates";
import { localHostCardModel, remoteHostCardModel } from "./host-card-model";

function remoteFixture(): RemoteHostRecord {
  return {
    config: {
      id: "box",
      name: "Build box",
      enabled: true,
      lan: "box.local",
      tailscale: null,
      mirror_budget_mb: 500,
    },
    os: "linux",
    status: {
      state: "connected",
      route: "lan",
      sync: "current",
      cpu_pct: 18,
      memory_pct: 42,
      last_seen_ms: 1791000000000,
      error: null,
      identity_changed: null,
      clock_offset_ms: 0,
      agent_version: "1.0.0",
      agent_update: { kind: "up_to_date", installed: "1.0.0" },
      update: null,
      last_update_failure: null,
      vitals: mockHostVitals(true),
    },
  };
}

describe("host card model", () => {
  it.each<[RemoteState, string, string | null, boolean]>([
    ["connected", "Live", null, true],
    ["connecting", "Connecting…", null, false],
    ["offline", "Offline", "Retry", false],
    ["disabled", "Connection off", "Turn on", false],
    ["error", "Connection failed", "Retry", false],
  ])(
    "presents %s with its state and action",
    (state, status, action, isLive) => {
      const remote = remoteFixture();
      remote.status.state = state;
      remote.status.error = "Permission denied (publickey)";
      const model = remoteHostCardModel(remote);
      expect(model).toMatchObject({ status, stateAction: action, isLive });
      if (!isLive) {
        expect(model.cpu).toBe("—");
        expect(model.memory).toBe("—");
        expect(model.vitals.every((vital) => vital.value === "—")).toBe(true);
        expect(model.diskWarning).toBeNull();
      }
      if (state === "offline") expect(model.route).toMatch(/^Last seen /);
      if (state === "error")
        expect(model.message).toEqual({
          tone: "error",
          text: "Permission denied (publickey)",
        });
    }
  );

  it("gives identity and required updates priority over connection errors", () => {
    const remote = remoteFixture();
    remote.status.state = "error";
    remote.status.identity_changed = "new-box";
    expect(remoteHostCardModel(remote)).toMatchObject({
      status: "Identity changed",
      mark: "warn",
      stateAction: "Re-pair…",
      isLive: false,
    });
    remote.status.identity_changed = null;
    remote.status.agent_update = {
      kind: "required",
      installed: "0.0.1",
      target: "1.0.0",
      via: "push",
    };
    expect(remoteHostCardModel(remote)).toMatchObject({
      status: "Update required",
      mark: "warn",
      stateAction: null,
      isLive: false,
    });
  });

  it("names the route and catching-up history", () => {
    const remote = remoteFixture();
    remote.status.sync = "catching_up";
    remote.status.route = "tailscale";
    expect(remoteHostCardModel(remote).route).toBe(
      "Tailscale · catching up history"
    );
  });

  it("keeps partial vitals missing and trusts Rust's disk warning", () => {
    const remote = remoteFixture();
    remote.status.vitals = {
      ...mockHostVitals(true),
      load_1m: null,
      cores: null,
      disk_free_bytes: null,
      net_rx_bps: null,
      memory_pressure: null,
      disk_low: true,
    };
    const model = remoteHostCardModel(remote);
    expect(model.vitals.map((v) => v.value)).toEqual(["—", "—", "56%", "—"]);
    expect(model.diskWarning).toBe("Disk 56%");
    remote.status.vitals.disk_low = false;
    expect(remoteHostCardModel(remote).diskWarning).toBeNull();
  });

  it.each([0, 1, 2])("names memory pressure level %s", (level) => {
    const remote = remoteFixture();
    remote.status.vitals.memory_pressure = { kind: "level", level };
    expect(remoteHostCardModel(remote).vitals[1]?.value).toBe(
      ["Normal", "Warn", "Critical"][level]
    );
  });

  it("formats stall pressure and each available vital", () => {
    const model = remoteHostCardModel(remoteFixture());
    expect(model.vitals).toEqual([
      { label: "Load", value: "0.72", secondary: "of 8 cores" },
      { label: "Mem pressure", value: "Some 0.12%" },
      { label: "Disk", value: "56%", secondary: "220 GB free" },
      { label: "Network", value: "↓ 1.3 MB/s", secondary: "↑ 148 KB/s" },
    ]);
  });

  it.each<[AgentUpdate, string]>([
    [{ kind: "unknown" }, "unknown"],
    [{ kind: "up_to_date", installed: "1.0.0" }, "latest"],
    [{ kind: "newer_than_this", installed: "2.0.0" }, "newer"],
    [
      { kind: "available", installed: "0.9.0", target: "1.0.0", via: "push" },
      "available",
    ],
    [
      {
        kind: "required",
        installed: "0.1.0",
        target: "1.0.0",
        via: "add_host",
      },
      "required",
    ],
  ])("carries the version state %o", (agent_update, kind) => {
    const remote = remoteFixture();
    remote.status.agent_update = agent_update;
    expect(remoteHostCardModel(remote).version.kind).toBe(kind);
  });

  it.each<UpdatePhase>([
    { kind: "queued" },
    { kind: "probing" },
    { kind: "uploading", sent_bytes: 6100000, total_bytes: 9400000 },
    { kind: "installing" },
    { kind: "restarting" },
    { kind: "reconnecting" },
    { kind: "unknown" },
  ])("carries update phase %o ahead of failure", (phase) => {
    const remote = remoteFixture();
    remote.status.update = { target: "1.0.1", phase };
    remote.status.last_update_failure = { target: "1.0.0", message: "timeout" };
    expect(remoteHostCardModel(remote).version).toMatchObject({
      kind: "updating",
      progress: phase,
    });
  });

  it("carries the last failure and retry action", () => {
    const remote = remoteFixture();
    remote.status.agent_update = {
      kind: "available",
      installed: "0.9.0",
      target: "1.0.0",
      via: "push",
    };
    remote.status.last_update_failure = { target: "1.0.0", message: "timeout" };
    expect(remoteHostCardModel(remote).version).toMatchObject({
      kind: "failed",
      action: { label: "Retry update" },
    });
  });

  it("builds This Mac from the local host and exposes Settings for its update", () => {
    const host = hostRecord(scenarioFlags([]), 1791000000000);
    const model = localHostCardModel(host, null, "1.0.0", "1.0.1", null, null);
    expect(model).toMatchObject({
      name: "This Mac",
      status: "Live",
      route: "This Mac",
      isLive: true,
      cpu: "—",
      memory: "—",
      version: { action: { kind: "settings", label: "Update" } },
    });
    expect(model.vitals.every((v) => v.value === "—")).toBe(true);
  });
});
