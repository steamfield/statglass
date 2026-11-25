import { PHONE_LAST_SEEN_MS } from "./mock/phone-errors";
import { createMockTransport } from "./mock-transport";
import {
  hostStatusSummary,
  localNetworkProblem,
  type PhoneAction,
  type PhoneProblemKind,
  type PhoneRemoteHostRecord,
  type PhoneRemoteHostStatus,
  phoneProblem,
} from "./phone-connection";

const cases = [
  [
    "tailscale-down",
    "tailscale_down",
    "Tailscale is off on this iPhone",
    "open_tailscale",
    /connect Tailscale/,
    "Tailscale is off",
  ],
  [
    "timeout",
    "timeout",
    "Connection to timeout timed out",
    "retry",
    /tailnet access rules/,
    "Connection timed out",
  ],
  [
    "name-not-resolved",
    "name_not_resolved",
    "Couldn’t find name-not-resolved",
    "retry",
    /host name/,
    "Host name not found",
  ],
  [
    "refused",
    "refused",
    "refused refused the SSH connection",
    "retry",
    /SSH is enabled/,
    "SSH connection refused",
  ],
  [
    "unreachable",
    "unreachable",
    "Can’t reach unreachable",
    "retry",
    /network/,
    "Host unreachable",
  ],
  ["offline", "offline", "offline is offline", "retry", /awake/, "Offline"],
  [
    "app-not-running",
    "app_not_running",
    "StatGlass isn’t running on app-not-running",
    "retry",
    /Open StatGlass on app-not-running/,
    "StatGlass isn’t running",
  ],
  [
    "monitoring-off",
    "monitoring_off",
    "Remote monitoring is off on monitoring-off",
    "retry",
    /Allow remote monitoring/,
    "Remote monitoring is off",
  ],
  [
    "agent-not-running",
    "agent_not_running",
    "The StatGlass agent isn’t running on agent-not-running",
    "retry",
    /agent/,
    "StatGlass agent isn’t running",
  ],
  [
    "identity-changed",
    "identity_changed",
    "Re-pair as a new host",
    "re_pair",
    /identity/,
    "Host identity changed",
  ],
  [
    "no-longer-authorized",
    "no_longer_authorized",
    "This iPhone is no longer authorized on no-longer-authorized",
    "re_pair",
    /restore access from this iPhone/,
    "iPhone no longer authorized",
  ],
  [
    "host-key-changed",
    "host_key_changed",
    "The SSH host key changed on host-key-changed",
    "re_pair",
    /fingerprint/,
    "SSH host key changed",
  ],
  [
    "key-not-accepted",
    "key_not_accepted",
    "Key not accepted by sshd",
    "re_pair",
    /iPhone’s key/,
    "Key not accepted by sshd",
  ],
  [
    "update-host",
    "update_host",
    "Update StatGlass on update-host",
    null,
    /newer version/,
    "Host update needed",
  ],
  [
    "update-app",
    "update_app",
    "Update this app",
    null,
    /App Store/,
    "iPhone app update needed",
  ],
  [
    "incompatible",
    "incompatible",
    "Can’t connect to incompatible with this StatGlass version",
    null,
    /compatible/,
    "Incompatible StatGlass connection",
  ],
  [
    "local-offline",
    "local_offline",
    "This iPhone is offline",
    null,
    /Wi-Fi or cellular/,
    "Waiting for network",
  ],
  [
    "phone-key-unavailable",
    "phone_key_unavailable",
    "This iPhone’s key is unavailable",
    "retry",
    /Re-pair/,
    "iPhone key unavailable",
  ],
  [
    "open-error",
    "internal",
    "Check the connection settings for open-error",
    "retry",
    /host address/,
    "Check connection settings",
  ],
  [
    "open-signer-error",
    "internal",
    "Couldn’t start the connection to open-signer-error",
    "retry",
    /close and reopen StatGlass/,
    "Couldn’t start connection",
  ],
  [
    "protocol",
    "internal",
    "Couldn’t read the response from protocol",
    "retry",
    /check the StatGlass versions/,
    "Couldn’t read host response",
  ],
  [
    "internal",
    "internal",
    "StatGlass lost its connection to internal",
    "retry",
    /try again/,
    "Connection failed",
  ],
] as const satisfies readonly (readonly [
  string,
  PhoneProblemKind,
  string,
  PhoneAction | null,
  RegExp,
  string,
])[];

async function fixture(name: string): Promise<PhoneRemoteHostRecord> {
  const transport = createMockTransport({
    scenarios: ["phone-errors"],
    historyRows: 2,
    now: () => PHONE_LAST_SEEN_MS,
  });
  try {
    const record = (await transport.listRemoteHosts()).find(
      (host) => host.config.id === `phone-${name}`
    );
    if (!record) throw new Error(`Missing phone error fixture: ${name}`);
    return record;
  } finally {
    transport.dispose();
  }
}

it.each(cases)(
  "words the %s state",
  async (name, kind, title, action, recovery, short) => {
    const record = await fixture(name);
    expect(phoneProblem(record)).toEqual({
      kind,
      title,
      action,
      recovery: expect.stringMatching(recovery),
      short,
      tone:
        kind === "offline" || kind === "local_offline" ? "muted" : "warning",
    });
  }
);

it("ignores old connection diagnostics on a connected host", async () => {
  const record = await fixture("open-error");
  record.status.state = "connected";
  expect(phoneProblem(record)).toBeNull();
  expect(
    hostStatusSummary(record.status, { nowMs: PHONE_LAST_SEEN_MS })
  ).toEqual({
    label: "Live",
    tone: "live",
    kind: null,
  });
});

it("falls back to internal for an unexpected startup error without claiming the host key changed", async () => {
  const record = await fixture("open-error");
  record.status.open_error = {
    kind: "host_key_unknown",
    message: "Unknown key",
  };
  expect(phoneProblem(record)).toMatchObject({
    kind: "internal",
    title: "Couldn’t start the connection to open-error",
    action: "retry",
  });
});

it("shows the cellular update cadence for a connected host in compact demand", async () => {
  const { status } = await fixture("open-error");
  const compact = { ...status, state: "connected", demand: "compact" } as const;
  expect(
    hostStatusSummary(compact, {
      nowMs: PHONE_LAST_SEEN_MS,
      requestedDemand: "full",
    })
  ).toEqual({ label: "Every 5 s on cellular", tone: "live", kind: null });
  expect(hostStatusSummary(compact, { nowMs: PHONE_LAST_SEEN_MS })).toEqual({
    label: "Live",
    tone: "live",
    kind: null,
  });
});

it("shows last seen and the next retry together in host time", async () => {
  const { status } = await fixture("offline");
  const opts = { nowMs: PHONE_LAST_SEEN_MS };
  expect(hostStatusSummary(status, opts).label).toBe("Offline since 14:02");
  status.next_attempt_ms = new Date(2026, 10, 24, 14, 5).getTime();
  expect(hostStatusSummary(status, opts).label).toBe(
    "Offline since 14:02 · Retrying at 14:07"
  );
});

it("shows last seen, not offline, for a host no screen is streaming", async () => {
  // A parked session: the core closed it after PARK_GRACE, with no failure.
  const { status } = await fixture("offline");
  const parked: PhoneRemoteHostStatus = {
    ...status,
    state: "offline",
    failure_kind: null,
    route_failures: [],
    next_attempt_ms: null,
    demand: null,
  };
  const opts = { nowMs: PHONE_LAST_SEEN_MS };
  expect(hostStatusSummary(parked, opts)).toEqual({
    label: "Last seen 14:02",
    tone: "muted",
    kind: null,
  });
  expect(hostStatusSummary({ ...parked, last_seen_ms: null }, opts).label).toBe(
    "Not connected"
  );
  // A demanded host in the same state is a real outage.
  expect(hostStatusSummary({ ...parked, demand: "full" }, opts).label).toBe(
    "Offline since 14:02"
  );
});

it.each(["timeout", "no_route", "unreachable"] as const)(
  "shows a previously seen host as offline after %s",
  async (kind) => {
    const record = await fixture("offline");
    record.status.failure_kind = kind;
    expect(phoneProblem(record)).toMatchObject({
      kind: "offline",
      tone: "muted",
    });
    expect(
      hostStatusSummary(record.status, { nowMs: PHONE_LAST_SEEN_MS })
    ).toMatchObject({
      label: "Offline since 14:02",
      tone: "muted",
    });
  }
);

it.each(["refused", "name_not_resolved"] as const)(
  "keeps %s actionable for a previously seen host",
  async (kind) => {
    const record = await fixture("offline");
    record.status.failure_kind = kind;
    expect(phoneProblem(record)).toMatchObject({ kind, tone: "warning" });
    expect(
      hostStatusSummary(record.status, { nowMs: PHONE_LAST_SEEN_MS })
    ).toMatchObject({
      kind,
      tone: "warning",
    });
  }
);

it("shows a fresh dial while the source retains the last network failure", async () => {
  const record = await fixture("local-offline");
  record.status.state = "connecting";
  record.status.dialing = true;
  record.status.waiting_for_network = false;
  record.status.last_seen_ms = PHONE_LAST_SEEN_MS;
  record.status.failure_kind = "local_offline";
  record.status.route_failures = [{ route: "lan", kind: "local_offline" }];
  expect(phoneProblem(record)).toBeNull();
  expect(
    hostStatusSummary(record.status, { nowMs: PHONE_LAST_SEEN_MS }).label
  ).toBe("Reconnecting");
});

it("seeds the agent's retry in phone time using the injected clock", async () => {
  const { status } = await fixture("agent-not-running");
  expect(status.next_attempt_ms).toBe(PHONE_LAST_SEEN_MS + 180_000);
});

it("gives native Local Network denial a Settings recovery", () => {
  expect(localNetworkProblem()).toEqual({
    kind: "local_network",
    title: "StatGlass needs Local Network access",
    short: "Local Network access needed",
    recovery: "Allow Local Network access for StatGlass in Settings.",
    action: "open_settings",
    tone: "warning",
  });
});
