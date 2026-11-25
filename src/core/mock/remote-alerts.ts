import { availableMetrics, newRule } from "@core/alerts";
import type { AlertRule, RemoteAlertRules } from "@core/generated/bindings";
import { MINUTE_MS } from "@core/time-grid";
import type { CommandResult } from "@core/transport";
import type { MockCommands } from "./commands";
import type { MockTransport } from "./contracts";
import { MOCK_HOST_ID, type ScenarioName } from "./fixtures";
import { fail, invalid, ok } from "./protocol";
import type { MockRemotes } from "./remote";

const LINUX = "remote-linux";
const DISK_ID = "c0ffee00-0000-4000-8000-0000000000e1";
const MEMORY_ID = "c0ffee00-0000-4000-8000-0000000000e2";
const NEWER_ID = "c0ffee00-0000-4000-8000-0000000000e3";
const CPU_ID = "c0ffee00-0000-4000-8000-0000000000e4";
const REVISION_MASK = (1n << 53n) - 1n;

function rulesAnswer(
  rules: AlertRule[],
  newer: RemoteAlertRules["newer"]
): RemoteAlertRules {
  // Like the agent, hash the ordered list. Sort object keys so a caller's
  // property insertion order has no effect. The mock only knows newer ids.
  const content = JSON.stringify([rules, newer], (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en-US"))
        )
      : value
  );
  let hash = 0xcbf2_9ce4_8422_2325n;
  for (const byte of new TextEncoder().encode(content)) {
    hash = ((hash ^ BigInt(byte)) * 0x0100_0000_01b3n) & REVISION_MASK;
  }
  return { revision: Number(hash), rules, newer };
}

function fixtureRule(metric: string, id: string, name: string): AlertRule {
  const [definition] = availableMetrics([metric]);
  if (!definition) throw new Error(`Unknown mock alert metric: ${metric}`);
  return { ...newRule(definition, id), name };
}

function initialRules(): RemoteAlertRules {
  const disk = fixtureRule("disk.free", DISK_ID, "Root disk running low");
  return rulesAnswer(
    [
      { ...disk, for_secs: 300 },
      fixtureRule("mem.psi", MEMORY_ID, "Memory stalls"),
    ],
    [{ id: NEWER_ID }]
  );
}

function seedRecentAlert(peer: MockTransport, now: number) {
  // The generic peer history includes a Mac built-in alert. Keep its detector
  // events, but use the agent's custom alert for this fixture.
  const queryEvents = peer.queryEvents;
  peer.queryEvents = async (...args) => {
    const result = await queryEvents(...args);
    return result.status === "ok"
      ? ok(
          result.data.filter(
            ({ detail }) =>
              detail.kind !== "alert" || detail.cause.type !== "process_cpu"
          )
        )
      : result;
  };
  const firedMs = now - 12 * MINUTE_MS;
  peer.recordEvent({
    ts_ms: firedMs,
    start_ms: firedMs - 5 * MINUTE_MS,
    processes: [],
    detail: {
      kind: "alert",
      rule_id: DISK_ID,
      rule_name: "Root disk running low",
      cause: {
        type: "threshold",
        metric: "disk.free",
        labels: [["vol", "/"]],
        value: 14e9,
        op: "lt",
        threshold: 20e9,
        for_secs: 300,
      },
    },
  });
}

type RulesResult = CommandResult<RemoteAlertRules>;
type AgentRules = {
  answer: RemoteAlertRules;
  pending: Promise<RulesResult> | null;
};

class MockRemoteAlerts {
  private readonly agents = new WeakMap<MockTransport, AgentRules>();
  private disconnected = false;
  private staleInjected = false;

  constructor(
    private readonly remotes: MockRemotes,
    private readonly commands: MockCommands,
    private readonly scenarios: readonly ScenarioName[],
    now: number
  ) {
    const linux = remotes.remotes.get(LINUX);
    if (linux) {
      this.agents.set(linux.peer, { answer: initialRules(), pending: null });
      seedRecentAlert(linux.peer, now);
    }
  }

  private target(
    host: string
  ): CommandResult<{ peer: MockTransport; state: AgentRules }> {
    if (host === MOCK_HOST_ID)
      return invalid("This Mac's alert rules are set in its Alerts page");
    const remote = this.remotes.remotes.get(host);
    if (!remote) return fail({ kind: "unknown_host", host });
    const { config, os, status } = remote.record;
    if (os !== "linux")
      return invalid(`Alert rules on ${config.name} are set on that Mac`);
    if (status.state !== "connected")
      return fail({
        kind: "remote_unreachable",
        message: "the host is not connected",
      });
    if (
      host === LINUX &&
      this.scenarios.includes("linux-agent-update") &&
      status.agent_version === "0.0.9"
    )
      return fail({
        kind: "remote_unsupported",
        message: "This host does not answer that query",
      });
    let state = this.agents.get(remote.peer);
    if (!state) {
      state = { answer: rulesAnswer([], []), pending: null };
      this.agents.set(remote.peer, state);
    }
    return ok({ peer: remote.peer, state });
  }

  private readonly read: MockTransport["remoteAlertRules"] = async (host) => {
    this.commands.record("remote_alert_rules", host);
    const target = this.target(host);
    if (target.status === "error") return target;
    const { state } = target.data;
    if (state.pending) await state.pending;
    if (
      host === LINUX &&
      this.scenarios.includes("linux-alerts-offline") &&
      !this.disconnected
    ) {
      this.disconnected = true;
      this.remotes.pushRemoteStatus(host, { state: "offline", route: null });
    }
    return ok(structuredClone(state.answer));
  };

  private readonly write: MockTransport["setRemoteAlertRules"] = async (
    host,
    baseRevision,
    rules,
    keep
  ) => {
    this.commands.record(
      "set_remote_alert_rules",
      host,
      baseRevision,
      rules,
      keep
    );
    const target = this.target(host);
    if (target.status === "error") return target;
    const { peer, state } = target.data;
    const replace = async () => {
      if (
        host === LINUX &&
        this.scenarios.includes("linux-alerts-stale") &&
        !this.staleInjected
      ) {
        this.staleInjected = true;
        state.answer = rulesAnswer(
          [
            ...state.answer.rules,
            fixtureRule("cpu.total", CPU_ID, "CPU saturation"),
          ],
          state.answer.newer
        );
      }
      return replaceRules(peer, state, baseRevision, rules, keep);
    };
    const pending = (state.pending ?? Promise.resolve()).then(replace);
    state.pending = pending;
    try {
      return await pending;
    } finally {
      if (state.pending === pending) state.pending = null;
    }
  };

  get methods() {
    return { remoteAlertRules: this.read, setRemoteAlertRules: this.write };
  }
}

export function mockRemoteMethods(
  remotes: MockRemotes,
  commands: MockCommands,
  scenarios: readonly ScenarioName[],
  now: number
) {
  return {
    ...remotes.methods,
    ...new MockRemoteAlerts(remotes, commands, scenarios, now).methods,
  };
}

async function replaceRules(
  peer: MockTransport,
  state: AgentRules,
  baseRevision: number,
  rules: AlertRule[],
  keep: string[]
): Promise<RulesResult> {
  const current = state.answer;
  if (baseRevision !== current.revision)
    return fail({
      kind: "remote_rules_changed",
      message:
        "The alert rules on this host changed. Reload them and try again.",
    });
  const known = [
    ...rules,
    ...current.rules.filter(({ id }) => keep.includes(id)),
  ];
  const newer = current.newer.filter(
    ({ id }) => id !== null && keep.includes(id)
  );
  // The peer knows the newer rule. Use a valid stand-in so its id and count
  // participate in the same validation as the known rules.
  const opaque = newer.flatMap(({ id }) =>
    id === null ? [] : [fixtureRule("cpu.total", id, "Newer rule")]
  );
  const result = await peer.updateSettings({
    alerts: { rules: [...known, ...opaque] },
  });
  if (result.status === "error" && result.error.kind === "settings_not_saved")
    return fail({
      kind: "internal",
      message: `Saving the alert rules: ${result.error.message}`,
    });
  if (result.status === "error") return result;
  state.answer = rulesAnswer(
    result.data.settings.alerts?.rules?.slice(0, known.length) ?? [],
    newer
  );
  return ok(structuredClone(state.answer));
}
