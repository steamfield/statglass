import { ALERT_LIMITS, type Event } from "@core/generated/bindings";
import type { ScenarioName } from "@core/mock/fixtures";
import { createMockTransport, type MockTransport } from "@core/mock-transport";
import { HOUR_MS, MINUTE_MS } from "@core/time-grid";
import { act, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { vi } from "vitest";
import { RulesPanel } from "./rules-panel";

const HOST_RULE = "A saved host is offline for 5 minutes";
const HOST_SUB = "Checked while this Mac is awake and online";

function transportWith(scenarios: ScenarioName[]): MockTransport {
  return createMockTransport({ scenarios, autoTick: false });
}

/** The sub line whose whole text (link included) matches `text`. */
function subLine(text: RegExp) {
  return screen.getByText(
    (_, el) => el?.tagName === "SPAN" && text.test(el.textContent ?? "")
  );
}

describe("Rules panel host-offline row", () => {
  it("is left out while no remote host is saved", async () => {
    const transport = transportWith([]);
    // Known once the host list has answered, empty.
    const list = transport.listRemoteHosts.bind(transport);
    let listed = false;
    transport.listRemoteHosts = async () => {
      const hosts = await list();
      listed = true;
      return hosts;
    };
    renderWithProviders(<RulesPanel onEdit={vi.fn()} />, { transport });
    const region = await screen.findByRole("region", { name: "Rules" });
    await within(region).findByRole("switch", {
      name: "Thermal state Serious or worse",
    });
    await waitFor(() => expect(listed).toBe(true));
    await act(async () => {});
    expect(within(region).getAllByRole("switch")).toHaveLength(2);
    expect(screen.queryByRole("switch", { name: HOST_RULE })).toBeNull();
  });

  it("follows the other built-in rows once a host is saved and writes its switch", async () => {
    const transport = transportWith(["multi-host"]);
    const { user } = renderWithProviders(<RulesPanel onEdit={vi.fn()} />, {
      transport,
    });
    const host = await screen.findByRole("switch", { name: HOST_RULE });
    const region = within(screen.getByRole("region", { name: "Rules" }));
    expect(
      region.getAllByRole("switch").map((s) => s.getAttribute("aria-label"))
    ).toEqual([
      "A process above 200% CPU for 5 minutes",
      "Thermal state Serious or worse",
      HOST_RULE,
    ]);
    expect(host).not.toBeChecked();
    await waitFor(() =>
      expect(subLine(new RegExp(`^${HOST_SUB} · Never fired$`))).toBeVisible()
    );
    await user.click(host);
    await waitFor(async () =>
      expect(
        (await transport.getSettings()).settings.alerts?.host_offline
      ).toBe(true)
    );
    expect(
      transport.calls
        .filter((c) => c.command === "update_settings")
        .map((c) => c.args[0])
    ).toEqual([{ alerts: { host_offline: true } }]);
  });

  it("links its last firing to the offline alert, not the later recovery", async () => {
    const transport = transportWith(["multi-host"]);
    const now = Date.now();
    const host = { host: "remote-studio", name: "Studio Mac" };
    const since = now - 3 * HOUR_MS - 5 * MINUTE_MS;
    const rule = {
      kind: "alert",
      rule_id: ALERT_LIMITS.host_offline_id,
      rule_name: "Saved host offline",
    } as const;
    const offline: Event = {
      ts_ms: now - 3 * HOUR_MS,
      start_ms: since,
      processes: [],
      detail: { ...rule, cause: { type: "host_offline", ...host } },
    };
    const back: Event = {
      ts_ms: now - HOUR_MS,
      start_ms: since,
      processes: [],
      detail: {
        ...rule,
        cause: { type: "host_back", ...host, offline_secs: 7500 },
      },
    };
    transport.queryEvents = async (_host, fromMs, toMs) => ({
      status: "ok",
      data: [offline, back].filter((e) => e.ts_ms >= fromMs && e.ts_ms < toMs),
    });
    const { user, router } = renderWithProviders(
      <RulesPanel onEdit={vi.fn()} />,
      { transport, route: "/dashboard/alerts" }
    );
    await screen.findByRole("switch", { name: HOST_RULE });
    await waitFor(() =>
      expect(
        subLine(new RegExp(`^${HOST_SUB} · Last fired 3 h ago$`))
      ).toBeVisible()
    );
    await user.click(
      screen.getByRole("button", { name: "Last fired 3 h ago" })
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/dashboard/timeline")
    );
    const window = (await transport.getSettings()).settings.general
      .chart_window;
    if (typeof window !== "object" || !("absolute" in window)) {
      throw new Error(`expected an absolute range, got ${String(window)}`);
    }
    expect(window.absolute.from_ms).toBeLessThanOrEqual(offline.start_ms);
    expect(window.absolute.to_ms).toBeGreaterThan(offline.ts_ms);
    expect(window.absolute.to_ms).toBeLessThan(back.ts_ms);
  });
});
