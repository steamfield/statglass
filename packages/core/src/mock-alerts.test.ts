import {
  ALERT_LIMITS,
  type AlertRule,
  type SettingsSnapshot,
} from "@core/generated/types";
import { MOCK_HOST_ID } from "./mock/fixtures";
import { createMockTransport } from "./mock-transport";

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function rule(n: number, overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    id: `c0ffee00-0000-4000-8000-${String(n).padStart(12, "0")}`,
    name: `Memory rule ${n}`,
    when: {
      threshold: {
        series: { metric: "mem.pressure", labels: [] },
        op: "gt",
        value: 80,
      },
    },
    for_secs: 120,
    cooldown_secs: 1800,
    enabled: true,
    ...overrides,
  };
}

function withValue(value: number): AlertRule {
  return rule(1, {
    when: {
      threshold: {
        series: { metric: "mem.pressure", labels: [] },
        op: "gt",
        value,
      },
    },
  });
}

describe("mock alert rules", () => {
  it("stores a rules patch and emits settings-changed with it", async () => {
    const t = createMockTransport({ now: () => NOW });
    const seen: SettingsSnapshot[] = [];
    t.onSettingsChanged((s) => seen.push(s));
    const res = await t.updateSettings({ alerts: { rules: [rule(1)] } });
    expect(res.status).toBe("ok");
    expect((await t.getSettings()).settings.alerts?.rules).toEqual([rule(1)]);
    expect(seen.map((s) => s.settings.alerts?.rules)).toEqual([[rule(1)]]);
  });

  const invalid: [string, AlertRule[]][] = [
    ["an empty name", [rule(1, { name: "" })]],
    ["a whitespace name", [rule(1, { name: "   " })]],
    ["a name over 60 characters", [rule(1, { name: "x".repeat(61) })]],
    ["a value below the metric's range", [withValue(0.5)]],
    ["a value above the metric's range", [withValue(101)]],
    ["a duration over an hour", [rule(1, { for_secs: 3601 })]],
    ["a cooldown under a minute", [rule(1, { cooldown_secs: 59 })]],
    ["a cooldown over a day", [rule(1, { cooldown_secs: 86_401 })]],
    ["more than 32 rules", Array.from({ length: 33 }, (_, i) => rule(i + 1))],
    ["two rules with one id", [rule(1), rule(1, { name: "Memory twin" })]],
    [
      "a built-in id",
      [rule(1, { id: "6b656c76-6f00-0000-0000-000000000001" })],
    ],
    ["an untrimmed name", [rule(1, { name: " Memory" })]],
  ];

  it.each(invalid)("rejects %s and stores nothing", async (_, rules) => {
    const t = createMockTransport({ now: () => NOW });
    const seen: SettingsSnapshot[] = [];
    t.onSettingsChanged((s) => seen.push(s));
    const before = await t.getSettings();
    const res = await t.updateSettings({ alerts: { rules } });
    expect(res).toMatchObject({
      status: "error",
      error: { kind: "invalid_settings" },
    });
    expect(await t.getSettings()).toEqual(before);
    expect(seen).toEqual([]);
  });

  // Rust admits rules in list order: a rule's own problem, then a repeated id,
  // then the count.
  const firstProblem: [string, AlertRule[], string][] = [
    [
      "a repeated id whose rule has an empty name",
      [rule(1), rule(1, { name: "" })],
      ALERT_LIMITS.messages.name,
    ],
    [
      "33 rules whose fifth is out of range",
      Array.from({ length: 33 }, (_, i) =>
        i === 4 ? rule(5, { cooldown_secs: 59 }) : rule(i + 1)
      ),
      ALERT_LIMITS.messages.cooldown,
    ],
  ];

  it.each(firstProblem)(
    "reports %s as Rust does",
    async (_, rules, message) => {
      const t = createMockTransport({ now: () => NOW });
      const res = await t.updateSettings({ alerts: { rules } });
      expect(res).toEqual({
        status: "error",
        error: { kind: "invalid_settings", message },
      });
    }
  );

  // Rust's `str::trim` keeps U+FEFF, which JS `trim()` strips, and strips
  // U+0085, which JS keeps.
  it("trims a name as Rust does", async () => {
    const t = createMockTransport({ now: () => NOW });
    const bom = String.fromCharCode(0xfeff);
    const nel = String.fromCharCode(0x85);
    const kept = await t.updateSettings({
      alerts: { rules: [rule(1, { name: `${bom}Memory` })] },
    });
    expect(kept.status).toBe("ok");
    const refused = await t.updateSettings({
      alerts: { rules: [rule(1, { name: `Memory${nel}` })] },
    });
    expect(refused).toEqual({
      status: "error",
      error: { kind: "invalid_settings", message: ALERT_LIMITS.messages.name },
    });
  });

  it("the alerts scenario holds a threshold alert and a process alert from the last day", async () => {
    const t = createMockTransport({ now: () => NOW, scenarios: ["alerts"] });
    const res = await t.queryEvents(MOCK_HOST_ID, NOW - DAY_MS, NOW + 1);
    if (res.status !== "ok") throw new Error(`query_events: ${res.status}`);
    const causes = res.data.flatMap((e) =>
      e.detail.kind === "alert" ? [e.detail.cause.type] : []
    );
    expect(causes).toContain("threshold");
    expect(causes).toContain("process_cpu");
  });
});
