import type {
  AgentUpdate,
  HostVitals,
  RemoteHostStatus,
  UpdatePhase,
} from "@core/generated/bindings";
import type { ScenarioName } from "./fixtures";
import type { MockRemotes } from "./remote";
import { APP_VERSION } from "./remote-linux";

const OLD = "0.0.9";
const behind = (via: "push" | "add_host"): AgentUpdate => ({
  kind: "available",
  installed: OLD,
  target: APP_VERSION,
  via,
});

function seed(
  remotes: MockRemotes,
  name: string,
  linux: boolean,
  status: Partial<RemoteHostStatus>
) {
  const record = remotes.addRemote(
    {
      id: `remote-${name}`,
      name,
      lan: `${name}.local`,
      tailscale: null,
      enabled: true,
      mirror_budget_mb: 100,
    },
    linux ? ["linux"] : ["no-battery", "no-fans"]
  );
  record.status = { ...record.status, ...status };
  return record;
}

/** Hosts behind, ahead of, or unable to talk to this Mac's version (D-123). */
export function seedUpdateScenarios(
  remotes: MockRemotes,
  scenarios: readonly ScenarioName[]
) {
  seedMonitoringScenarios(remotes, scenarios);
  if (scenarios.includes("host-unreachable"))
    seed(remotes, "unreachable", true, {
      state: "error",
      route: null,
      last_seen_ms: null,
      cpu_pct: null,
      memory_pct: null,
      vitals: {
        cores: 8,
        load_1m: null,
        memory_pressure: null,
        disk_used_bytes: null,
        disk_free_bytes: null,
        disk_total_bytes: null,
        disk_low: false,
        net_rx_bps: null,
        net_tx_bps: null,
      },
      error:
        "SSH command failed (127): /usr/local/bin/statglass-agent: No such file or directory",
      clock_offset_ms: null,
    });
  if (scenarios.includes("hosts-outdated")) {
    for (const name of ["nas", "build-box"])
      seed(remotes, name, true, {
        agent_version: OLD,
        agent_update: behind("push"),
      });
    seed(remotes, "studio", false, {
      agent_version: OLD,
      agent_update: behind("add_host"),
    });
    seed(remotes, "pi", true, {
      state: "offline",
      route: null,
      cpu_pct: null,
      memory_pct: null,
      agent_version: OLD,
      agent_update: behind("push"),
    });
  }
  if (scenarios.includes("host-incompatible"))
    seed(remotes, "legacy", true, {
      state: "error",
      route: null,
      cpu_pct: null,
      memory_pct: null,
      error: "incompatible remote: protocol 1 is below the supported range 2-3",
      agent_version: "0.0.1",
      agent_update: {
        kind: "required",
        installed: "0.0.1",
        target: APP_VERSION,
        via: "push",
      },
    });
  if (scenarios.includes("host-newer"))
    seed(remotes, "edge", true, {
      agent_version: "0.2.0",
      agent_update: { kind: "newer_than_this", installed: "0.2.0" },
    });
}

/** Measured fixture facts; production thresholds and projections live in Rust. */
export function mockHostVitals(linux = false): HostVitals {
  return {
    load_1m: linux ? 0.72 : 2.4,
    cores: linux ? 8 : 14,
    memory_pressure: linux
      ? { kind: "stall", some_pct: 0.12 }
      : { kind: "level", level: 0 },
    disk_used_bytes: 280_000_000_000,
    disk_free_bytes: 220_000_000_000,
    disk_total_bytes: 500_000_000_000,
    disk_low: false,
    net_rx_bps: 1_250_000,
    net_tx_bps: 148_000,
  };
}

function seedMonitoringScenarios(
  remotes: MockRemotes,
  scenarios: readonly ScenarioName[]
) {
  if (scenarios.includes("hosts-dashboard")) {
    for (const name of ["studio", "build", "nas", "offline", "partial"]) {
      const record = seed(remotes, name, name !== "studio", {});
      if (name === "offline")
        record.status = {
          ...record.status,
          state: "offline",
          route: null,
          cpu_pct: null,
          memory_pct: null,
        };
      if (name === "nas")
        record.status.vitals = {
          ...record.status.vitals,
          disk_used_bytes: 499_000_000_000,
          disk_free_bytes: 1_000_000_000,
          disk_low: true,
        };
      if (name === "partial")
        record.status.vitals = {
          ...record.status.vitals,
          load_1m: null,
          disk_used_bytes: null,
          disk_free_bytes: null,
          disk_total_bytes: null,
        };
    }
  }
  if (scenarios.includes("host-updating")) {
    const record = seed(remotes, "updating", true, {
      agent_version: OLD,
      agent_update: behind("push"),
    });
    remotes.startUpdate(record.config.id);
  }
  if (scenarios.includes("host-update-failed"))
    seed(remotes, "failed", true, {
      agent_version: OLD,
      agent_update: behind("push"),
      last_update_failure: {
        target: APP_VERSION,
        message:
          "The host did not reconnect with the updated agent within three minutes",
      },
    });
}

/** Timed phases use the same status push seam as native notifications. */
export class MockAgentUpdates {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  constructor(private readonly remotes: MockRemotes) {}
  start(id: string) {
    const phases: UpdatePhase[] = [
      { kind: "queued" },
      { kind: "probing" },
      { kind: "uploading", sent_bytes: 0, total_bytes: 8_000_000 },
      { kind: "uploading", sent_bytes: 4_000_000, total_bytes: 8_000_000 },
      { kind: "installing" },
      { kind: "restarting" },
      { kind: "reconnecting" },
    ];
    for (const [i, phase] of phases.entries()) {
      if (i === 0)
        this.remotes.pushRemoteStatus(id, {
          update: { target: APP_VERSION, phase },
        });
      else
        this.after(i * 1500, () =>
          this.remotes.pushRemoteStatus(id, {
            update: { target: APP_VERSION, phase },
            ...(phase.kind === "reconnecting" ? { state: "connecting" } : {}),
          })
        );
    }
    this.after(phases.length * 1500, () =>
      this.remotes.pushRemoteStatus(id, {
        state: "connected",
        update: null,
        last_update_failure: null,
        agent_version: APP_VERSION,
        agent_update: { kind: "up_to_date", installed: APP_VERSION },
      })
    );
  }
  private after(ms: number, run: () => void) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, ms);
    this.timers.add(timer);
  }
  dispose() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

export function seedRemoteScenarios(
  remotes: MockRemotes,
  scenarios: readonly ScenarioName[]
) {
  seedUpdateScenarios(remotes, scenarios);
  if (scenarios.includes("multi-host"))
    remotes.addRemote({
      id: "remote-studio",
      name: "Studio Mac",
      lan: "studio.local",
      tailscale: "studio-tailnet",
      enabled: true,
      mirror_budget_mb: 100,
    });
  if (scenarios.includes("linux-host")) {
    const linux = remotes.addRemote(
      {
        id: "remote-linux",
        name: "linux-tailscale",
        lan: null,
        tailscale: "linux-tailscale",
        enabled: true,
        mirror_budget_mb: 100,
      },
      ["linux"]
    );
    if (scenarios.includes("linux-agent-update")) {
      const peer = remotes.remotes.get(linux.config.id);
      if (peer) peer.automaticUpdates = false;
      linux.status = {
        ...linux.status,
        agent_version: "0.0.9",
        agent_update: {
          kind: "available",
          installed: "0.0.9",
          target: APP_VERSION,
          via: "push",
        },
      };
    }
    if (scenarios.includes("linux-identity-changed"))
      linux.status = {
        ...linux.status,
        state: "error",
        error:
          "remote host identity does not match: linux-tailscale identified 48670e8f-2bca-4868-b557-16b1f1289341, expected 91d73b19-5d36-43b5-87f1-884bd635378e",
        identity_changed: "48670e8f-2bca-4868-b557-16b1f1289341",
        cpu_pct: null,
        memory_pct: null,
      };
  }
}
