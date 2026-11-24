import { availableMetrics, newRule } from "@core/alerts";
import type { AlertRule } from "@core/generated/types";
import { createMockTransport, type MockTransport } from "@core/mock-transport";
import { act, screen, waitFor, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { renderWithProviders } from "@tests/test-utils";
import { useState } from "react";
import { useHost } from "~/stores/host-store";
import { RuleDialog, type RuleDraft } from "./rule-dialog";

const RULE_ID = "c0ffee00-0000-4000-8000-0000000000f1";

function ruleOn(metricId: string, change: Partial<AlertRule> = {}): AlertRule {
  const metric = availableMetrics([metricId])[0];
  if (!metric) throw new Error(`${metricId} is not an alertable metric`);
  return { ...newRule(metric, RULE_ID), name: "Watch this", ...change };
}

function thresholdValue(rule: AlertRule | undefined): number {
  if (!rule || !("threshold" in rule.when) || !rule.when.threshold) {
    throw new Error("expected a threshold rule");
  }
  return rule.when.threshold.value ?? Number.NaN;
}

function withLabels(rule: AlertRule, labels: [string, string][]): AlertRule {
  if (!("threshold" in rule.when) || !rule.when.threshold) return rule;
  const { series, ...rest } = rule.when.threshold;
  return {
    ...rule,
    when: { threshold: { ...rest, series: { ...series, labels } } },
  };
}

async function settle(
  transport: MockTransport,
  patch: Parameters<MockTransport["updateSettings"]>[0]
) {
  const saved = await transport.updateSettings(patch);
  if (saved.status === "error") throw new Error(JSON.stringify(saved.error));
}

function LayoutReady() {
  return useHost((s) => s.layoutNo) === null ? null : <span>layout</span>;
}

function Harness({ initial }: { initial: RuleDraft }) {
  const [draft, setDraft] = useState<RuleDraft | null>(initial);
  return (
    <>
      <LayoutReady />
      <RuleDialog draft={draft} onClose={() => setDraft(null)} />
    </>
  );
}

async function open(rule: AlertRule, stored: AlertRule[] = [rule]) {
  const transport = createMockTransport({ autoTick: false });
  await settle(transport, { alerts: { rules: stored } });
  const view = renderWithProviders(
    <Harness initial={{ rule, isNew: false }} />,
    { transport }
  );
  await screen.findByText("layout");
  await screen.findByRole("dialog", { name: "Edit rule" });
  return { ...view, transport };
}

async function storedRules(transport: MockTransport) {
  return (await transport.getSettings()).settings.alerts?.rules ?? [];
}

const threshold = () => screen.getByRole("textbox", { name: "Threshold" });

async function setThreshold(user: UserEvent, text: string) {
  await user.clear(threshold());
  await user.type(threshold(), text);
}

async function saveAndClose(user: UserEvent) {
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

describe("Rule dialog edges", () => {
  it("rebuilds the form in the new unit when units change while it is open", async () => {
    const hottest = ruleOn("thermal.hottest");
    const { user, transport } = await open(hottest);
    expect(threshold()).toHaveValue("95");
    await act(() =>
      settle(transport, { units: { temperature: "fahrenheit" } })
    );
    await waitFor(() => expect(threshold()).toHaveValue("203"));
    expect(within(screen.getByRole("dialog")).getByText("°F")).toBeVisible();
    await saveAndClose(user);
    const value = thresholdValue((await storedRules(transport))[0]);
    expect(Math.abs(value - 95)).toBeLessThan(1e-4);
  });

  it("keeps an edited rule that another window deleted", async () => {
    const pressure = ruleOn("mem.pressure");
    const { user, transport } = await open(pressure);
    await act(() => settle(transport, { alerts: { rules: [] } }));
    await setThreshold(user, "85");
    await saveAndClose(user);
    const rules = await storedRules(transport);
    expect(rules.map((r) => r.id)).toEqual([RULE_ID]);
    expect(thresholdValue(rules[0])).toBe(85);
  });

  it("takes enabled from the stored rule, not from when the dialog opened", async () => {
    const pressure = ruleOn("mem.pressure");
    const { user, transport } = await open(pressure);
    await act(() =>
      settle(transport, {
        alerts: { rules: [{ ...pressure, enabled: false }] },
      })
    );
    await setThreshold(user, "85");
    await saveAndClose(user);
    expect((await storedRules(transport))[0]?.enabled).toBe(false);
  });

  it.each([
    [
      "Cancel",
      (user: UserEvent) =>
        user.click(screen.getByRole("button", { name: "Cancel" })),
    ],
    ["Escape", (user: UserEvent) => user.keyboard("{Escape}")],
    [
      "the close button",
      (user: UserEvent) =>
        user.click(screen.getByRole("button", { name: "Close" })),
    ],
  ])("closes with %s while a save never answers", async (_how, dismiss) => {
    const pressure = ruleOn("mem.pressure");
    const { user, transport } = await open(pressure);
    transport.updateSettings = () => new Promise(() => undefined);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    await dismiss(user);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows a watched series that is no longer live", async () => {
    const fan = withLabels(ruleOn("fan.rpm"), [["fan", "2"]]);
    const { user } = await open(fan);
    const watch = screen.getByRole("combobox", { name: "Watch" });
    expect(watch).toHaveTextContent("Fan 3");
    await user.click(watch);
    const options = (await screen.findAllByRole("option")).map(
      (o) => o.textContent
    );
    expect(options).toEqual(["Any", "Fan 1", "Fan 2", "Fan 3"]);
  });

  it("reads a comma as the decimal separator", async () => {
    const { user, transport } = await open(ruleOn("mem.pressure"));
    await setThreshold(user, "80,5");
    await saveAndClose(user);
    expect(thresholdValue((await storedRules(transport))[0])).toBe(80.5);
  });

  it.each(["1,000", "1,000.5", "0,125"])(
    "refuses %s, which may hold a thousands separator",
    async (typed) => {
      const { user } = await open(ruleOn("fan.rpm"));
      await setThreshold(user, typed);
      expect(
        screen.getByText("Enter a number without thousands separators")
      ).toBeVisible();
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    }
  );

  it("prints the range in the metric's own format", async () => {
    const { user } = await open(ruleOn("fan.rpm"));
    await setThreshold(user, "100");
    expect(screen.getByText("Between 500 and 20,000 rpm")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("clears a save error when the form is edited", async () => {
    const { user, transport } = await open(ruleOn("mem.pressure"));
    transport.updateSettings = async () => ({
      status: "error",
      error: { kind: "settings_not_saved", message: "disk full" },
    });
    await user.click(screen.getByRole("button", { name: "Save" }));
    const failure = "Couldn't save settings. Nothing changed.";
    expect(await screen.findByText(failure)).toBeVisible();
    await setThreshold(user, "85");
    expect(screen.queryByText(failure)).toBeNull();
  });
});
