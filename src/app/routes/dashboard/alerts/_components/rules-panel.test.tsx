import { availableMetrics, newRule } from "@core/alerts";
import type { AlertRule, Event } from "@core/generated/bindings";
import { MOCK_HOST_ID, type ScenarioName } from "@core/mock/fixtures";
import { createMockTransport, type MockTransport } from "@core/mock-transport";
import { MINUTE_MS } from "@core/time-grid";
import { act, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { Profiler } from "react";
import { vi } from "vitest";
import { useHost } from "~/stores/host-store";
import { RulesPanel } from "./rules-panel";

/** The `alerts` scenario's seeded memory pressure alert fires this rule. */
const PRESSURE_ID = "c0ffee00-0000-4000-8000-0000000000a1";
const CPU_ID = "c0ffee00-0000-4000-8000-0000000000c1";
const BATTERY_ID = "c0ffee00-0000-4000-8000-0000000000d1";

function customRule(
  metricId: string,
  id: string,
  change: Partial<AlertRule>
): AlertRule {
  const metric = availableMetrics([metricId])[0];
  if (!metric) throw new Error(`${metricId} is not an alertable metric`);
  return { ...newRule(metric, id), ...change };
}

/** Named apart from its sentence, "Memory pressure above 80% for 2 min". */
const PRESSURE = customRule("mem.pressure", PRESSURE_ID, {
  name: "Pressure watch",
});
/** Named by its own sentence. */
const CPU = customRule("cpu.total", CPU_ID, {
  name: "CPU usage above 90% for 5 min",
});
const BATTERY = customRule("battery.charge", BATTERY_ID, {
  name: "Low battery",
});

async function seeded(
  rules: AlertRule[],
  scenarios: ScenarioName[] = ["alerts"]
): Promise<MockTransport> {
  const transport = createMockTransport({ scenarios, autoTick: false });
  const saved = await transport.updateSettings({ alerts: { rules } });
  if (saved.status === "error") {
    throw new Error(`seeding rules failed: ${JSON.stringify(saved.error)}`);
  }
  return transport;
}

async function savedAlerts(transport: MockTransport) {
  return (await transport.getSettings()).settings.alerts;
}

function rulesRegion() {
  return screen.getByRole("region", { name: "Rules" });
}

async function alertEvent(
  transport: MockTransport,
  ruleId: string
): Promise<Event> {
  const answer = await transport.queryEvents(
    MOCK_HOST_ID,
    0,
    Number.MAX_SAFE_INTEGER
  );
  if (answer.status === "error") throw new Error(JSON.stringify(answer.error));
  const event = answer.data.find(
    (e) => e.detail.kind === "alert" && e.detail.rule_id === ruleId
  );
  if (!event) throw new Error(`no seeded alert for rule ${ruleId}`);
  return event;
}

describe("Rules panel", () => {
  it("lists the built-in rules first and writes their switches", async () => {
    const transport = await seeded([PRESSURE]);
    const { user } = renderWithProviders(<RulesPanel onEdit={vi.fn()} />, {
      transport,
    });
    await screen.findByRole("switch", { name: "Pressure watch" });
    const region = within(rulesRegion());
    expect(region.getAllByRole("switch")).toEqual(
      [
        "A process above 200% CPU for 5 minutes",
        "Thermal state Serious or worse",
        "Pressure watch",
      ].map((name) => region.getByRole("switch", { name }))
    );
    expect(
      screen.queryByRole("button", { name: /^Edit (A process|Thermal)/ })
    ).toBeNull();

    await user.click(
      screen.getByRole("switch", {
        name: "A process above 200% CPU for 5 minutes",
      })
    );
    await waitFor(async () =>
      expect((await savedAlerts(transport))?.hot_process).toBe(true)
    );
    await user.click(
      screen.getByRole("switch", { name: "Thermal state Serious or worse" })
    );
    await waitFor(async () =>
      expect((await savedAlerts(transport))?.thermal_serious).toBe(true)
    );
    expect(
      transport.calls
        .filter((call) => call.command === "update_settings")
        .slice(1)
        .map((call) => call.args[0])
    ).toEqual([
      { alerts: { hot_process: true } },
      { alerts: { thermal_serious: true } },
    ]);
  });

  it("labels a custom rule by its name, adding the sentence only when they differ", async () => {
    const transport = await seeded([PRESSURE, CPU]);
    renderWithProviders(<RulesPanel onEdit={vi.fn()} />, { transport });
    const region = await screen.findByRole("region", { name: "Rules" });
    await within(region).findByText("Pressure watch");
    expect(
      await within(region).findByText(/Memory pressure above 80% for 2 min/)
    ).toBeInTheDocument();
    await within(region).findByText(/Last fired 1 h ago/);
    // Named by its sentence: the sentence shows once, as the label.
    expect(
      within(region).getAllByText(/CPU usage above 90% for 5 min/)
    ).toHaveLength(1);
    expect(within(region).getAllByText(/Never fired/)).toHaveLength(2);
  });

  it("opens the Timeline on the hour around the rule's last alert", async () => {
    const transport = await seeded([PRESSURE]);
    const fired = await alertEvent(transport, PRESSURE_ID);
    const { user, router } = renderWithProviders(
      <RulesPanel onEdit={vi.fn()} />,
      { transport, route: "/dashboard/alerts" }
    );
    await user.click(await screen.findByText(/Last fired 1 h ago/));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/dashboard/timeline")
    );
    expect(
      (await transport.getSettings()).settings.general.chart_window
    ).toEqual({
      absolute: {
        from_ms: fired.ts_ms - 30 * MINUTE_MS,
        to_ms: fired.ts_ms + 30 * MINUTE_MS,
      },
    });
  });

  it("says a rule on a metric this Mac lacks is not measured, keeping its switch", async () => {
    const transport = await seeded([PRESSURE, BATTERY], ["no-battery"]);
    renderWithProviders(<RulesPanel onEdit={vi.fn()} />, { transport });
    await waitFor(() => {
      expect(screen.getAllByText(/Not measured on this Mac/)).toHaveLength(1);
      expect(screen.getAllByText(/Never fired/)).toHaveLength(2);
    });
    expect(screen.getByRole("switch", { name: "Low battery" })).toBeChecked();
  });

  it("switches one custom rule by writing the whole list", async () => {
    const transport = await seeded([PRESSURE, CPU]);
    const { user } = renderWithProviders(<RulesPanel onEdit={vi.fn()} />, {
      transport,
    });
    await user.click(
      await screen.findByRole("switch", {
        name: "CPU usage above 90% for 5 min",
      })
    );
    await waitFor(async () =>
      expect((await savedAlerts(transport))?.rules).toEqual([
        PRESSURE,
        { ...CPU, enabled: false },
      ])
    );
    expect(
      transport.calls
        .filter((call) => call.command === "update_settings")
        .slice(1)
        .map((call) => call.args[0])
    ).toEqual([{ alerts: { rules: [PRESSURE, { ...CPU, enabled: false }] } }]);
  });

  it("hands the rule to the editor from its Edit button", async () => {
    const transport = await seeded([PRESSURE, CPU]);
    const onEdit = vi.fn<(rule: AlertRule) => void>();
    const { user } = renderWithProviders(<RulesPanel onEdit={onEdit} />, {
      transport,
    });
    await user.click(
      await screen.findByRole("button", { name: "Edit Pressure watch" })
    );
    expect(onEdit.mock.calls).toEqual([[PRESSURE]]);
  });

  it("does not re-render on a live tick", async () => {
    const transport = await seeded([PRESSURE, CPU]);
    let renders = 0;
    function LayoutReady() {
      return useHost((s) => s.layoutNo) === null ? null : <span>layout</span>;
    }
    renderWithProviders(
      <>
        <LayoutReady />
        <Profiler
          id="rules"
          onRender={() => {
            renders += 1;
          }}
        >
          <RulesPanel onEdit={vi.fn()} />
        </Profiler>
      </>,
      { transport }
    );
    await screen.findByText("layout");
    await screen.findByText(/Last fired 1 h ago/);
    await screen.findAllByText(/Never fired/);
    // Drain subscription, settings and query startup before counting.
    await act(async () => {});
    const settled = renders;
    for (let tick = 0; tick < 3; tick++) {
      await act(async () => transport.tick());
    }
    expect(renders).toBe(settled);
  });
});
