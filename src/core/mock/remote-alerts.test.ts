import { ALERT_LIMITS } from "@core/generated/bindings";
import { createMockTransport } from "@core/mock-transport";
import { MOCK_HOST_ID, type ScenarioName } from "./fixtures";

const LINUX = "remote-linux";

function mock(scenarios: readonly ScenarioName[]) {
  const transport = createMockTransport({ autoTick: false, scenarios });
  onTestFinished(() => transport.dispose());
  return transport;
}

it("refuses rule reads and writes on This Mac, a remote Mac, and unknown hosts", async () => {
  const transport = mock(["multi-host"]);
  const cases = [
    [
      MOCK_HOST_ID,
      {
        kind: "invalid_argument",
        message: "This Mac's alert rules are set in its Alerts page",
      },
    ],
    [
      "remote-studio",
      {
        kind: "invalid_argument",
        message: "Alert rules on Studio Mac are set on that Mac",
      },
    ],
    ["absent", { kind: "unknown_host", host: "absent" }],
  ] as const;
  for (const [host, error] of cases) {
    const refused = { status: "error", error };
    expect(await transport.remoteAlertRules(host)).toEqual(refused);
    expect(await transport.setRemoteAlertRules(host, 1, [], [])).toEqual(
      refused
    );
  }
});

it("validates and serializes replacements, preserving only the requested newer rule", async () => {
  const transport = mock(["linux-host"]);
  const initial = await transport.remoteAlertRules(LINUX);
  if (initial.status === "error")
    throw new Error(JSON.stringify(initial.error));
  const { revision, rules, newer } = initial.data;
  const [disk] = rules;
  const keep = newer.flatMap(({ id }) => (id === null ? [] : [id]));
  if (!disk) throw new Error("Missing disk rule");
  expect(
    await transport.setRemoteAlertRules(
      LINUX,
      revision,
      [{ ...disk, name: "" }],
      keep
    )
  ).toEqual({
    status: "error",
    error: { kind: "invalid_settings", message: ALERT_LIMITS.messages.name },
  });
  expect(await transport.remoteAlertRules(LINUX)).toEqual(initial);

  const changed = { ...disk, enabled: false };
  const results = await Promise.all([
    transport.setRemoteAlertRules(LINUX, revision, [changed], keep),
    transport.setRemoteAlertRules(LINUX, revision, [], []),
  ]);
  expect(results).toEqual([
    { status: "ok", data: { revision: revision + 1, rules: [changed], newer } },
    {
      status: "error",
      error: {
        kind: "remote_rules_changed",
        message:
          "The alert rules on this host changed. Reload them and try again.",
      },
    },
  ]);
  expect(await transport.remoteAlertRules(LINUX)).toEqual(results[0]);
  expect(
    await transport.setRemoteAlertRules(LINUX, revision + 1, [changed], [])
  ).toEqual({
    status: "ok",
    data: { revision: revision + 2, rules: [changed], newer: [] },
  });
});

it("answers like an unsupported agent or a host that disappeared after the first read", async () => {
  const old = mock(["linux-agent-update"]);
  const offline = mock(["linux-alerts-offline"]);
  expect(await old.remoteAlertRules(LINUX)).toEqual({
    status: "error",
    error: {
      kind: "remote_unsupported",
      message: "This host does not answer that query",
    },
  });
  expect((await offline.remoteAlertRules(LINUX)).status).toBe("ok");
  expect((await offline.listRemoteHosts())[0]?.status.state).toBe("offline");
  expect(await offline.remoteAlertRules(LINUX)).toEqual({
    status: "error",
    error: { kind: "remote_unreachable", message: "the host is not connected" },
  });
});

it("uses the agent's disk-write refusal and keeps the old rules on disk failure", async () => {
  const transport = createMockTransport({
    autoTick: false,
    scenarios: ["linux-host"],
    settingsNotSaved: true,
  });
  onTestFinished(() => transport.dispose());
  const initial = await transport.remoteAlertRules(LINUX);
  if (initial.status === "error")
    throw new Error(JSON.stringify(initial.error));
  expect(
    await transport.setRemoteAlertRules(LINUX, initial.data.revision, [], [])
  ).toEqual({
    status: "error",
    error: { kind: "internal", message: "Saving the alert rules: disk full" },
  });
  expect(await transport.remoteAlertRules(LINUX)).toEqual(initial);
});
