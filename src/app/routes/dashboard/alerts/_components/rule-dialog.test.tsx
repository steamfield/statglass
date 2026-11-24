import { availableMetrics, newRule, ruleSummary } from "@core/alerts";
import {
  ALERT_LIMITS,
  ALERT_METRICS,
  type AlertRule,
  type UnitSettings,
} from "@core/generated/types";
import type { ScenarioName } from "@core/mock/fixtures";
import { createMockTransport, type MockTransport } from "@core/mock-transport";
import { settingsErrorText } from "@core/settings-patch";
import { act, screen, waitFor, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { renderWithProviders } from "@tests/test-utils";
import { useState } from "react";
import { useHost } from "~/stores/host-store";
import { RuleDialog, type RuleDraft } from "./rule-dialog";

const NEW_ID = "c0ffee00-0000-4000-8000-0000000000e1";
const SAVED_ID = "c0ffee00-0000-4000-8000-0000000000e2";
const MOCK_UNITS: UnitSettings = {
  temperature: "celsius",
  network: "bytes_per_sec",
  memory: "decimal",
};

function ruleOn(metricId: string, id: string): AlertRule {
  const metric = availableMetrics([metricId])[0];
  if (!metric) throw new Error(`${metricId} is not an alertable metric`);
  return newRule(metric, id);
}

function thresholdOf(rule: AlertRule | undefined) {
  if (!rule || !("threshold" in rule.when) || !rule.when.threshold) {
    throw new Error("expected a threshold rule");
  }
  return rule.when.threshold;
}

/** A saved rule named apart from its sentence. */
const SAVED: AlertRule = {
  ...ruleOn("mem.pressure", SAVED_ID),
  name: "Pressure watch",
};

interface Setup {
  rules?: AlertRule[];
  units?: Partial<UnitSettings>;
  scenarios?: ScenarioName[];
  settingsNotSaved?: boolean;
}

async function seeded({
  rules = [],
  units,
  scenarios = [],
  settingsNotSaved = false,
}: Setup): Promise<MockTransport> {
  const transport = createMockTransport({ scenarios, autoTick: false });
  if (rules.length > 0 || units) {
    const saved = await transport.updateSettings({
      alerts: { rules },
      ...(units ? { units } : {}),
    });
    if (saved.status === "error") {
      throw new Error(
        `seeding settings failed: ${JSON.stringify(saved.error)}`
      );
    }
  }
  if (settingsNotSaved) {
    transport.updateSettings = async () => ({
      status: "error",
      error: { kind: "settings_not_saved", message: "disk full" },
    });
  }
  return transport;
}

function LayoutReady() {
  return useHost((s) => s.layoutNo) === null ? null : <span>layout</span>;
}

/** The dialog as the route holds it: closing clears the draft. */
function Harness({ initial }: { initial: RuleDraft }) {
  const [draft, setDraft] = useState<RuleDraft | null>(initial);
  return (
    <>
      <LayoutReady />
      <RuleDialog draft={draft} onClose={() => setDraft(null)} />
    </>
  );
}

async function open(draft: RuleDraft, setup: Setup = {}) {
  const transport = await seeded(setup);
  const view = renderWithProviders(<Harness initial={draft} />, { transport });
  await screen.findByText("layout");
  const dialog = await screen.findByRole("dialog", {
    name: draft.isNew ? "New rule" : "Edit rule",
  });
  const settingsCalls = () =>
    transport.calls.filter((call) => call.command === "update_settings").length;
  return { ...view, transport, dialog, writesBefore: settingsCalls() };
}

async function choose(user: UserEvent, field: string, option: string) {
  await user.click(screen.getByRole("combobox", { name: field }));
  await user.click(await screen.findByRole("option", { name: option }));
}

async function optionsOf(user: UserEvent, field: string) {
  await user.click(screen.getByRole("combobox", { name: field }));
  const names = (await screen.findAllByRole("option")).map(
    (o) => o.textContent
  );
  await user.keyboard("{Escape}");
  return names;
}

async function storedRules(transport: MockTransport) {
  return (await transport.getSettings()).settings.alerts?.rules ?? [];
}

function writes(transport: MockTransport) {
  return transport.calls.filter((call) => call.command === "update_settings");
}

const threshold = () => screen.getByRole("textbox", { name: "Threshold" });
const name = () => screen.getByRole("textbox", { name: "Name" });

describe("Rule dialog", () => {
  it("offers only the metrics this Mac measures", async () => {
    const { user } = await open(
      { rule: ruleOn("cpu.total", NEW_ID), isNew: true },
      { scenarios: ["no-battery"] }
    );
    expect(await optionsOf(user, "Metric")).toEqual(
      ALERT_METRICS.filter((m) => m.metric !== "battery.charge").map(
        (m) => m.label
      )
    );
  });

  it("fills a chosen metric's comparison, threshold, duration and name", async () => {
    const { user } = await open({
      rule: ruleOn("cpu.total", NEW_ID),
      isNew: true,
    });
    expect(name()).toHaveValue("CPU usage above 90% for 5 min");
    await choose(user, "Metric", "Battery charge");
    expect(screen.getByRole("radio", { name: "below" })).toBeChecked();
    expect(threshold()).toHaveValue("20");
    expect(screen.getByRole("combobox", { name: "For" })).toHaveTextContent(
      "Right away"
    );
    expect(name()).toHaveValue(
      ruleSummary(ruleOn("battery.charge", NEW_ID), MOCK_UNITS)
    );
  });

  it("keeps a typed name through a metric change", async () => {
    const { user } = await open({
      rule: ruleOn("cpu.total", NEW_ID),
      isNew: true,
    });
    await user.clear(name());
    await user.type(name(), "Busy Mac");
    await choose(user, "Metric", "Memory pressure");
    expect(name()).toHaveValue("Busy Mac");
    expect(threshold()).toHaveValue("80");
  });

  it("offers Any then each series for a labelled metric, disks starting on /", async () => {
    const { user } = await open({
      rule: ruleOn("cpu.total", NEW_ID),
      isNew: true,
    });
    expect(screen.queryByRole("combobox", { name: "Watch" })).toBeNull();
    await choose(user, "Metric", "Free disk space");
    expect(screen.getByRole("combobox", { name: "Watch" })).toHaveTextContent(
      "/"
    );
    expect(await optionsOf(user, "Watch")).toEqual([
      "Any",
      "/System/Volumes/Data",
      "/",
    ]);
    await choose(user, "Metric", "Fan speed");
    expect(await optionsOf(user, "Watch")).toEqual(["Any", "Fan 1", "Fan 2"]);
  });

  it.each([
    {
      metric: "thermal.hottest",
      units: { temperature: "fahrenheit" } as const,
      shown: "203",
      unit: "°F",
      typed: "200",
      stored: ((200 - 32) * 5) / 9,
    },
    {
      metric: "mem.swap_used",
      units: { memory: "binary" } as const,
      shown: "3.72529",
      unit: "GiB",
      typed: "2",
      stored: 2 * 2 ** 30,
    },
  ])("shows and stores a $metric threshold in $unit", async (c) => {
    const { user, transport } = await open(
      { rule: ruleOn(c.metric, NEW_ID), isNew: true },
      { units: c.units }
    );
    expect(threshold()).toHaveValue(c.shown);
    expect(
      within(screen.getByRole("dialog")).getByText(c.unit)
    ).toBeInTheDocument();
    await user.clear(threshold());
    await user.type(threshold(), c.typed);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () =>
      expect(await storedRules(transport)).toHaveLength(1)
    );
    const value = thresholdOf((await storedRules(transport))[0]).value ?? 0;
    expect(Math.abs(value - c.stored) / c.stored).toBeLessThan(1e-6);
  });

  it("shows what blocks saving inline and disables Save", async () => {
    const { user } = await open({
      rule: ruleOn("cpu.total", NEW_ID),
      isNew: true,
    });
    const save = () => screen.getByRole("button", { name: "Save" });
    expect(save()).toBeEnabled();
    await user.clear(threshold());
    expect(screen.getByText("Enter a number")).toBeVisible();
    expect(save()).toBeDisabled();
    await user.type(threshold(), "150");
    expect(screen.getByText("Between 1 and 100%")).toBeVisible();
    expect(save()).toBeDisabled();
    await user.clear(threshold());
    await user.type(threshold(), "95");
    await user.clear(name());
    expect(screen.getByText("Give the rule a name")).toBeVisible();
    expect(save()).toBeDisabled();
  });

  it("appends a new rule in one patch and closes", async () => {
    const { user, transport, writesBefore } = await open(
      { rule: ruleOn("cpu.total", NEW_ID), isNew: true },
      { rules: [SAVED] }
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await storedRules(transport)).toEqual([
      SAVED,
      {
        ...ruleOn("cpu.total", NEW_ID),
        name: "CPU usage above 90% for 5 min",
      },
    ]);
    expect(writes(transport)).toHaveLength(writesBefore + 1);
  });

  it("replaces an edited rule in one patch and closes", async () => {
    const other = { ...ruleOn("cpu.total", NEW_ID), name: "Busy Mac" };
    const { user, transport, writesBefore } = await open(
      { rule: SAVED, isNew: false },
      { rules: [SAVED, other] }
    );
    await user.clear(threshold());
    await user.type(threshold(), "85");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const rules = await storedRules(transport);
    expect(rules).toEqual([
      {
        ...SAVED,
        when: {
          threshold: { ...thresholdOf(SAVED), value: 85 },
        },
      },
      other,
    ]);
    expect(writes(transport)).toHaveLength(writesBefore + 1);
  });

  it.each([
    {
      answer: "invalid_settings",
      setup: {
        rules: Array.from({ length: ALERT_LIMITS.max_custom }, (_, i) => ({
          ...ruleOn(
            "cpu.total",
            `c0ffee00-0000-4000-8000-${String(i).padStart(12, "0")}`
          ),
          name: `Rule ${i + 1}`,
        })),
      },
      error: {
        kind: "invalid_settings",
        message: ALERT_LIMITS.messages.too_many,
      },
    },
    {
      answer: "settings_not_saved",
      setup: { settingsNotSaved: true },
      error: { kind: "settings_not_saved", message: "disk full" },
    },
  ])("keeps the form open with the reason on $answer", async (c) => {
    const { user } = await open(
      { rule: ruleOn("cpu.total", NEW_ID), isNew: true },
      c.setup
    );
    await user.clear(threshold());
    await user.type(threshold(), "85");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(settingsErrorText(c.error))).toBeVisible();
    expect(screen.getByRole("dialog", { name: "New rule" })).toBeVisible();
    expect(threshold()).toHaveValue("85");
  });

  it("deletes an existing rule and closes; a new rule has no Delete", async () => {
    const first = await open(
      { rule: ruleOn("cpu.total", NEW_ID), isNew: true },
      { rules: [SAVED] }
    );
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    first.unmount();

    const { user, transport } = await open(
      { rule: SAVED, isNew: false },
      { rules: [SAVED] }
    );
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await storedRules(transport)).toEqual([]);
  });

  it.each([
    [
      "Cancel",
      (user: UserEvent) =>
        user.click(screen.getByRole("button", { name: "Cancel" })),
    ],
    ["Escape", (user: UserEvent) => user.keyboard("{Escape}")],
  ])("writes nothing on %s", async (_how, dismiss) => {
    const { user, transport, writesBefore } = await open(
      { rule: SAVED, isNew: false },
      { rules: [SAVED] }
    );
    await user.clear(threshold());
    await user.type(threshold(), "85");
    await dismiss(user);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(writes(transport)).toHaveLength(writesBefore);
    expect(await storedRules(transport)).toEqual([SAVED]);
  });

  it("shows the watched series' value now and keeps the form through ticks", async () => {
    const { user, transport } = await open({
      rule: ruleOn("cpu.total", NEW_ID),
      isNew: true,
    });
    await user.clear(threshold());
    await user.type(threshold(), "77");
    const now = () => screen.getByText(/^Now \d+%$/).textContent;
    const first = now();
    let changed = false;
    for (let tick = 0; tick < 10 && !changed; tick++) {
      await act(async () => transport.tick());
      changed = now() !== first;
    }
    expect(changed).toBe(true);
    expect(threshold()).toHaveValue("77");
  });
});
