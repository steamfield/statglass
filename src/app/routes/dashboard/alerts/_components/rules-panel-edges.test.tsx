import { availableMetrics, newRule } from "@core/alerts";
import type {
  AlertRule,
  SettingsPatch,
  SettingsSnapshot,
} from "@core/generated/bindings";
import { MOCK_HOST_ID } from "@core/mock/fixtures";
import { createMockTransport, type MockTransport } from "@core/mock-transport";
import { MINUTE_MS } from "@core/time-grid";
import type { CommandResult } from "@core/transport";
import { act, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { Profiler } from "react";
import { vi } from "vitest";
import { RulesPanel } from "./rules-panel";

const PRESSURE_ID = "c0ffee00-0000-4000-8000-0000000000a1";
const CPU_ID = "c0ffee00-0000-4000-8000-0000000000c1";

function customRule(metricId: string, id: string, name: string): AlertRule {
  const metric = availableMetrics([metricId])[0];
  if (!metric) throw new Error(`${metricId} is not an alertable metric`);
  return { ...newRule(metric, id), name };
}

const PRESSURE = customRule("mem.pressure", PRESSURE_ID, "Pressure watch");
const CPU = customRule("cpu.total", CPU_ID, "Busy Mac");

async function seeded(rules: AlertRule[]): Promise<MockTransport> {
  const transport = createMockTransport({
    scenarios: ["alerts"],
    autoTick: false,
  });
  const saved = await transport.updateSettings({ alerts: { rules } });
  if (saved.status === "error") throw new Error(JSON.stringify(saved.error));
  return transport;
}

/** The sub line whose whole text (link included) matches `text`. */
function subLine(text: RegExp) {
  return screen.getByText(
    (_, el) => el?.tagName === "SPAN" && text.test(el.textContent ?? "")
  );
}

/** Holds every settings write until `release` is called. */
function holdWrites(transport: MockTransport) {
  const write = transport.updateSettings.bind(transport);
  const held: (() => void)[] = [];
  transport.updateSettings = (patch: SettingsPatch) =>
    new Promise<CommandResult<SettingsSnapshot>>((resolve) => {
      held.push(() => void write(patch).then(resolve));
    });
  return () => {
    for (const run of held.splice(0)) run();
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Rules panel edges", () => {
  it("gives the built-in rows their description and last-fired line", async () => {
    const transport = await seeded([]);
    renderWithProviders(<RulesPanel onEdit={vi.fn()} />, { transport });
    await waitFor(() =>
      expect(
        subLine(
          /^Any one process, for the whole 5 minutes · Last fired \d+ h ago$/
        )
      ).toBeInTheDocument()
    );
    expect(
      subLine(/^macOS is slowing the Mac down to cool it · Never fired$/)
    ).toBeInTheDocument();
  });

  it("names the Alerts are on notification in its note", async () => {
    const transport = await seeded([]);
    renderWithProviders(<RulesPanel onEdit={vi.fn()} />, { transport });
    expect(
      await screen.findByText(/sends an “Alerts are on” notification/)
    ).toBeInTheDocument();
  });

  it("moves the last-fired time on as the minutes pass", async () => {
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ["Date", "setInterval", "clearInterval"],
    });
    const transport = await seeded([PRESSURE]);
    renderWithProviders(<RulesPanel onEdit={vi.fn()} />, { transport });
    await screen.findByText("Last fired 1 h ago");
    act(() => {
      vi.advanceTimersByTime(60 * MINUTE_MS);
    });
    expect(await screen.findByText("Last fired 2 h ago")).toBeInTheDocument();
  });

  it("locks every switch and Edit button while a rules write is pending", async () => {
    const transport = await seeded([PRESSURE, CPU]);
    const release = holdWrites(transport);
    const { user } = renderWithProviders(<RulesPanel onEdit={vi.fn()} />, {
      transport,
    });
    await user.click(await screen.findByRole("switch", { name: "Busy Mac" }));
    const locked = [
      ...screen.getAllByRole("switch"),
      ...screen.getAllByRole("button", { name: /^Edit / }),
    ];
    expect(locked).toHaveLength(6);
    for (const control of locked) expect(control).toBeDisabled();
    // A second click while the first write is out does nothing.
    await user.click(screen.getByRole("switch", { name: "Pressure watch" }));
    release();
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Pressure watch" })
      ).toBeEnabled()
    );
    expect((await transport.getSettings()).settings.alerts?.rules).toEqual([
      PRESSURE,
      { ...CPU, enabled: false },
    ]);
  });

  it("does not re-render on a live tick", async () => {
    const transport = await seeded([PRESSURE, CPU]);
    let renders = 0;
    renderWithProviders(
      <Profiler id="rules" onRender={() => (renders += 1)}>
        <RulesPanel onEdit={vi.fn()} />
      </Profiler>,
      { transport }
    );
    await screen.findByText("Last fired 1 h ago");
    await act(async () => {});
    const settled = renders;
    for (let tick = 0; tick < 3; tick++) {
      await act(async () => transport.tick());
    }
    expect(renders).toBe(settled);
  });

  it("shows no last-fired line when the alerts could not be read", async () => {
    const transport = await seeded([PRESSURE]);
    transport.queryEvents = async () => ({
      status: "error",
      error: { kind: "store_busy", message: "history.sqlite is locked" },
    });
    renderWithProviders(<RulesPanel onEdit={vi.fn()} />, { transport });
    await waitFor(() =>
      expect(
        subLine(/^Any one process, for the whole 5 minutes$/)
      ).toBeInTheDocument()
    );
    expect(
      subLine(/^Memory pressure above 80% for 2 min$/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/Never fired|Last fired/)).toBeNull();
  });

  it("writes the last-fired time as plain text when its history is gone", async () => {
    const transport = await seeded([PRESSURE]);
    const health = await transport.historyHealth(MOCK_HOST_ID);
    if (health.status === "error") {
      throw new Error(JSON.stringify(health.error));
    }
    transport.setHistoryHealth({
      ...health.data,
      trimmed_before_ms: Date.now() - 30 * MINUTE_MS,
    });
    renderWithProviders(<RulesPanel onEdit={vi.fn()} />, { transport });
    await waitFor(() =>
      expect(
        subLine(/^Memory pressure above 80% for 2 min · Last fired 1 h ago$/)
      ).toBeInTheDocument()
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Last fired/ })).toBeNull()
    );
  });
});
