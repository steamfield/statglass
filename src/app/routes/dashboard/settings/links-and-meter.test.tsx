import type { SettingsPatch } from "@core/generated/types";
import { createMockTransport, type MockTransport } from "@core/mock-transport";
import { act, screen, waitFor, within } from "@testing-library/react";
import { type SettingsTabId, settingsHref } from "~/lib/settings-links";
import { renderWithProviders } from "../../../../../tests/test-utils";
import SettingsRoute from "./route";

const renderTab = (tab: SettingsTabId, transport?: MockTransport) =>
  renderWithProviders(<SettingsRoute />, {
    route: settingsHref(tab),
    ...(transport ? { transport } : {}),
  });

const rowEl = (id: string) =>
  document.querySelector(`[data-settings-row="${id}"]`);

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe("Settings disabled-reason links", () => {
  it.each<{
    name: string;
    tab: SettingsTabId;
    patch: SettingsPatch;
    link: string;
    target: { tab: SettingsTabId; row: string };
  }>([
    {
      name: "an off module's menu-bar value row links to it in Monitoring",
      tab: "menu-bar",
      patch: { modules: { power: { enabled: false } } },
      link: "Monitoring",
      target: { tab: "monitoring", row: "module-power" },
    },
    {
      name: "Install updates links to Check for updates while that is off",
      tab: "about",
      patch: { general: { check_updates: false } },
      link: "Check for updates automatically",
      target: { tab: "about", row: "check-updates" },
    },
    {
      name: "Set by Performance mode links to Performance mode",
      tab: "monitoring",
      patch: { sampling: { performance_mode: true } },
      link: "Performance mode",
      target: { tab: "monitoring", row: "performance-mode" },
    },
  ])("$name", async ({ tab, patch, link, target }) => {
    const { transport, user, router } = renderTab(tab);
    await screen.findByRole("tablist");
    await act(() => transport.updateSettings(patch));

    const links = await screen.findAllByRole("link", { name: link });
    for (const a of links) {
      expect(a).toHaveAttribute("href", settingsHref(target.tab, target.row));
    }
    await user.click(links[0] as HTMLElement);

    expect(router.state.location.pathname).toBe(settingsHref(target.tab));
    await waitFor(() =>
      expect(rowEl(target.row)).toHaveAttribute("data-flash")
    );
    expect(rowEl(target.row)?.scrollIntoView).toHaveBeenCalled();
  });

  it("keeps the reason text whole around the link", async () => {
    const { transport } = renderTab("menu-bar");
    await screen.findByRole("tablist");
    await act(() =>
      transport.updateSettings({ modules: { gpu: { enabled: false } } })
    );
    const bars = await waitFor(() => {
      const el = rowEl("menu-bar-bars");
      expect(el).toHaveTextContent("Turn on GPU in Monitoring to show its bar");
      return el as HTMLElement;
    });
    expect(
      within(bars).getByRole("link", { name: "Monitoring" })
    ).toHaveAttribute("href", settingsHref("monitoring", "module-gpu"));
  });
});

describe("History storage meter", () => {
  const track = () => screen.getByRole("img", { name: /used, growing to/ });
  const meterText = () => track().parentElement?.textContent ?? "";

  it("shows the size on disk, the limit and a projection that follows the settings", async () => {
    const { transport } = renderTab("history");
    // The mock store holds 148 MB under a 750 MB limit, keeping 30 days.
    await waitFor(() =>
      expect(track()).toHaveAccessibleName(
        /^148 MB used, growing to about \d+ MB of a 750 MB limit$/
      )
    );
    expect(meterText()).toContain("148 MB on disk now");
    expect(meterText()).toContain("750 MB limit");
    expect(meterText()).toContain("Recorded so far");
    expect(meterText()).toMatch(/About \d+ MB once 30 days are kept/);
    const thirtyDays = track().getAttribute("aria-label");

    await act(() =>
      transport.updateSettings({ history: { retention_days: 7 } })
    );
    await waitFor(() =>
      expect(track().getAttribute("aria-label")).not.toBe(thirtyDays)
    );
    expect(meterText()).toMatch(/About \d+ MB once 7 days are kept/);

    await act(() =>
      transport.updateSettings({
        history: { retention_days: 365, size_limit_mb: 150 },
      })
    );
    await waitFor(() =>
      expect(track()).toHaveAccessibleName(
        "148 MB used, growing to about 150 MB of a 150 MB limit"
      )
    );
    expect(meterText()).toContain("About 150 MB once the limit is reached");
  });

  it.each<{ name: string; arrange: (t: MockTransport) => void; label: RegExp }>(
    [
      {
        name: "the size read fails",
        arrange: (t) =>
          t.failNext("historySize", { kind: "remote_busy", message: "busy" }),
        label: /^— used, growing to about \d+ MB of a 750 MB limit$/,
      },
      {
        name: "the size read is pending",
        // No mock option holds a reply, so this host's read never answers.
        arrange: (t) =>
          Object.assign(t, { historySize: () => new Promise(() => {}) }),
        label: /^— used, growing to about \d+ MB of a 750 MB limit$/,
      },
      {
        name: "the growth read fails",
        arrange: (t) =>
          t.failNext("historyGrowth", { kind: "remote_busy", message: "busy" }),
        label: /^148 MB used, growing to about — of a 750 MB limit$/,
      },
    ]
  )("shows MISSING figures while $name", async ({ arrange, label }) => {
    const transport = createMockTransport({ autoTick: false });
    arrange(transport);
    renderTab("history", transport);
    await waitFor(() => expect(track()).toHaveAccessibleName(label));
    // The other read answered; only the missing figure has no bar.
    expect(track().children).toHaveLength(1);
    expect(meterText()).toContain("750 MB limit");
  });
});
