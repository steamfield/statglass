import type {
  AgentUpdate,
  AgentUpdateVia,
  RemoteHostRecord,
  RemoteState,
  UpdatePhase,
  UpdateStatus,
} from "@core/generated/bindings";
import { mockHostVitals } from "./mock/remote-updates";
import {
  agentVersionLine,
  agentVersionState,
  hostUpdateNotice,
  localUpdateTarget,
  releaseUrl,
  updatePhaseText,
} from "./remote-hosts";

function host(
  agent_update: AgentUpdate,
  state: RemoteState = "connected"
): RemoteHostRecord {
  return {
    config: {
      id: "h",
      name: "box",
      lan: "box",
      tailscale: null,
      enabled: true,
      mirror_budget_mb: 100,
    },
    os: "linux",
    status: {
      state,
      route: "lan",
      last_seen_ms: null,
      error: null,
      sync: "current",
      clock_offset_ms: 0,
      cpu_pct: null,
      memory_pct: null,
      agent_version:
        "installed" in agent_update ? agent_update.installed : null,
      agent_update,
      identity_changed: null,
      rr: null,
      vitals: mockHostVitals(true),
      update: null,
      last_update_failure: null,
    },
  };
}

const behind = host({
  kind: "available",
  installed: "0.3.0",
  target: "0.3.1",
  via: "push",
});
const current = host({ kind: "up_to_date", installed: "0.3.1" });
const blocked = host({
  kind: "required",
  installed: "0.2.0",
  target: "0.3.1",
  via: "push",
});

describe("hostUpdateNotice", () => {
  it("says nothing when every host is current or unknown", () => {
    expect(
      hostUpdateNotice([current, host({ kind: "unknown" })], null, null)
    ).toBeNull();
  });

  it("counts hosts behind and keys the dismissal to the target", () => {
    const notice = hostUpdateNotice([behind, behind, current], null, null);
    expect(notice).toEqual({ kind: "hosts", count: 2, key: "hosts:0.3.1" });
    expect(hostUpdateNotice([behind], null, "hosts:0.3.1")).toBeNull();
    expect(hostUpdateNotice([behind], null, "hosts:0.3.0")).not.toBeNull();
  });

  it("puts this Mac's own pending update first", () => {
    const available: UpdateStatus = {
      kind: "available",
      version: "0.3.2",
      notes: "",
    };
    expect(hostUpdateNotice([behind], available, "hosts:0.3.1")).toEqual({
      kind: "local_first",
      version: "0.3.2",
      key: "local:0.3.2",
    });
    expect(
      hostUpdateNotice([behind], { kind: "ready", version: "0.3.2" }, null)
    ).toMatchObject({ kind: "local_restart" });
    expect(hostUpdateNotice([behind], available, "local:0.3.2")).toBeNull();
  });

  it("can't dismiss a host that can't connect", () => {
    expect(hostUpdateNotice([blocked, behind], null, "hosts:0.3.1")).toEqual({
      kind: "required",
      count: 1,
    });
  });
});

describe("localUpdateTarget", () => {
  it.each<[UpdateStatus, string | null]>([
    [{ kind: "idle" }, null],
    [{ kind: "up_to_date" }, null],
    [{ kind: "checking" }, null],
    [{ kind: "failed", message: "x" }, null],
    [{ kind: "compatibility_blocked", version: "0.4.0", message: "x" }, null],
    [{ kind: "downloading", version: "0.3.2", percent: 10 }, "0.3.2"],
    [{ kind: "needs_authorization", version: "0.3.2" }, "0.3.2"],
    [{ kind: "installing", version: "0.3.2" }, "0.3.2"],
  ])("%o → %s", (status, target) => {
    expect(localUpdateTarget(status)).toBe(target);
  });
});

describe("agentVersionLine", () => {
  it("shares the current and available copy with cards", () => {
    expect(agentVersionLine(behind, null)?.text).toBe(
      "StatGlass 0.3.0 · 0.3.1 available"
    );
    expect(agentVersionLine(current, "0.3.2")?.text).toBe(
      "StatGlass 0.3.1 · Latest · 0.3.2 after updating this Mac"
    );
    expect(agentVersionLine(host({ kind: "unknown" }), null)?.text).toBe(
      "Version not reported yet"
    );
  });
  it("defers offline updates and offers a reinstall for a reachable Mac", () => {
    const offline = host(behind.status.agent_update, "offline");
    expect(agentVersionState(offline)).toMatchObject({
      text: "StatGlass 0.3.0 · 0.3.1 available, updates once reachable",
      action: null,
    });
    expect(
      agentVersionState(
        host({
          kind: "available",
          installed: "0.3.0",
          target: "0.3.1",
          via: "add_host",
        })
      )
    ).toMatchObject({
      action: { kind: "add_host", label: "Reinstall 0.3.1…" },
    });
  });
  it("offers updates to incompatible hosts, and names newer hosts", () => {
    expect(agentVersionState(blocked)).toMatchObject({
      text: "Needs 0.3.1 to connect",
      action: { kind: "push", label: "Update to 0.3.1" },
    });
    expect(
      agentVersionState(host({ kind: "newer_than_this", installed: "0.4.0" }))
        .text
    ).toBe("StatGlass 0.4.0 · Newer than this Mac");
  });
  it("keeps disabled and identity-changed hosts out of updates", () => {
    expect(
      agentVersionState({
        ...behind,
        config: { ...behind.config, enabled: false },
      }).action
    ).toBeNull();
    expect(
      agentVersionState({
        ...behind,
        status: { ...behind.status, identity_changed: "new" },
      }).action
    ).toBeNull();
  });
  it.each<[UpdatePhase, string]>([
    [{ kind: "queued" }, "Waiting for another update"],
    [{ kind: "probing" }, "Checking the host"],
    [
      { kind: "uploading", sent_bytes: 6100000, total_bytes: 9400000 },
      "Uploading 6.1 of 9.4 MB",
    ],
    [{ kind: "installing" }, "Installing"],
    [{ kind: "restarting" }, "Restarting"],
    [{ kind: "reconnecting" }, "Reconnecting"],
    [{ kind: "unknown" }, "Updating"],
  ])("names update phase %o", (phase, text) => {
    expect(updatePhaseText(phase)).toBe(text);
    expect(
      agentVersionState({
        ...behind,
        status: { ...behind.status, update: { target: "0.3.1", phase } },
      }).text
    ).toBe(`Updating to 0.3.1 · ${text}`);
  });
  it("names failures and offers a retry", () => {
    expect(
      agentVersionState({
        ...behind,
        status: {
          ...behind.status,
          last_update_failure: {
            via: "push",
            target: "0.3.1",
            message: "timeout",
          },
        },
      })
    ).toMatchObject({
      text: "Update to 0.3.1 failed",
      icon: "error",
      action: { label: "Retry update" },
    });
  });
});

describe("releaseUrl", () => {
  it("links only plain versions", () => {
    expect(releaseUrl("0.3.1")).toBe(
      "https://github.com/steamfield/statglass/releases/tag/v0.3.1"
    );
    expect(releaseUrl("0.3.1/../../settings")).toBeNull();
  });
});

it("offers failed-update recovery while monitoring is disconnected", () => {
  const remote: RemoteHostRecord = {
    ...behind,
    status: {
      ...behind.status,
      state: "offline",
      last_update_failure: {
        via: "push",
        target: "0.3.1",
        message: "The new agent did not reconnect",
      },
    },
  };
  expect(agentVersionState(remote).action).toEqual({
    kind: "push",
    label: "Retry update",
  });
  expect(
    agentVersionState({
      ...remote,
      config: { ...remote.config, enabled: false },
    }).action
  ).toBeNull();
  expect(
    agentVersionState({
      ...remote,
      status: { ...remote.status, identity_changed: "new-id" },
    }).action
  ).toBeNull();
});

it.each<AgentUpdateVia>(["push", "add_host"])(
  "uses the recorded failure route %s regardless of OS or current version state",
  (via) => {
    const systems: RemoteHostRecord["os"][] = ["linux", "mac_os"];
    for (const os of systems) {
      for (const agent_update of [
        current.status.agent_update,
        behind.status.agent_update,
      ]) {
        const remote: RemoteHostRecord = {
          ...current,
          os,
          status: {
            ...current.status,
            agent_update,
            last_update_failure: { target: "1.0.0", message: "timeout", via },
          },
        };
        expect(agentVersionState(remote).action).toEqual({
          kind: via,
          label: "Retry update",
        });
      }
    }
  }
);
