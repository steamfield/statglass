import type { ScenarioName } from "@core/mock/fixtures";
import { createMockTransport, type MockTransport } from "@core/mock-transport";
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

  it("says when a host last went offline or came back", async () => {
    const transport = transportWith(["multi-host", "mac-offline"]);
    renderWithProviders(<RulesPanel onEdit={vi.fn()} />, { transport });
    await screen.findByRole("switch", { name: HOST_RULE });
    // The newest host alert is the recovery, 78 minutes ago.
    await waitFor(() =>
      expect(
        subLine(new RegExp(`^${HOST_SUB} · Last fired 1 h ago$`))
      ).toBeVisible()
    );
  });
});
