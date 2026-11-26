import { act, screen, waitFor, within } from "@testing-library/react";
import {
  SETTINGS_TABS,
  type SettingsTabId,
  settingsHref,
} from "~/lib/settings-links";
import { renderWithProviders } from "../../../../../tests/test-utils";
import { SETTINGS_CATALOG, sectionsOf } from "./_lib/catalog";
import SettingsRoute from "./route";

/** Renders Settings at a path under `/dashboard/settings` ("", "/history?focus=x"). */
const renderAt = (rest: string) =>
  renderWithProviders(<SettingsRoute />, {
    route: `/dashboard/settings${rest}`,
  });

const tab = (name: string) =>
  screen.getByRole("tab", { name: new RegExp(`^${name}`) });

const rowsOnPage = () =>
  [...document.querySelectorAll("[data-settings-row]")].map(
    (el) => el.getAttribute("data-settings-row") ?? ""
  );

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe("Settings tabs", () => {
  it("lists the six tabs in order and opens on General", async () => {
    renderAt("");
    await screen.findByRole("heading", { name: "Startup" });
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(
      SETTINGS_TABS.map((t) => expect.stringContaining(t.label))
    );
    expect(tab("General")).toHaveAttribute("aria-selected", "true");
    for (const title of ["Startup", "Appearance", "Units"]) {
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    }
    expect(screen.queryByRole("heading", { name: "Sampling" })).toBeNull();
  });

  it("falls back to General for an unknown tab", async () => {
    renderAt("/nope");
    expect(
      await screen.findByRole("heading", { name: "Startup" })
    ).toBeInTheDocument();
    expect(tab("General")).toHaveAttribute("aria-selected", "true");
  });

  it("opens the tab the URL names", async () => {
    renderAt("/history");
    expect(
      await screen.findByRole("heading", { name: "Clear history" })
    ).toBeInTheDocument();
    expect(tab("History")).toHaveAttribute("aria-selected", "true");
  });

  it("writes the chosen tab into the URL", async () => {
    const { router, user } = renderAt("");
    await screen.findByRole("heading", { name: "Startup" });
    await user.click(tab("Monitoring"));
    await screen.findByRole("switch", { name: "Performance mode" });
    expect(router.state.location.pathname).toBe(settingsHref("monitoring"));
  });

  it("moves between tabs with the arrow keys", async () => {
    const { user } = renderAt("");
    await screen.findByRole("heading", { name: "Startup" });
    act(() => tab("General").focus());
    await user.keyboard("{ArrowRight}");
    await waitFor(() =>
      expect(tab("Menu bar")).toHaveAttribute("aria-selected", "true")
    );
    await user.keyboard("{ArrowLeft}");
    await waitFor(() =>
      expect(tab("General")).toHaveAttribute("aria-selected", "true")
    );
  });

  it.each(SETTINGS_TABS.map((t) => t.id))(
    "shows every catalog row of %s once and none of another tab's",
    async (id: SettingsTabId) => {
      renderAt(`/${id}`);
      const own = sectionsOf(id).flatMap((s) => s.rows.map((r) => r.id));
      await waitFor(() =>
        expect(rowsOnPage()).toEqual(expect.arrayContaining(own))
      );
      const rows = rowsOnPage();
      for (const row of own) {
        expect(rows.filter((r) => r === row)).toHaveLength(1);
      }
      const others = SETTINGS_CATALOG.filter((s) => s.tab !== id).flatMap((s) =>
        s.rows.map((r) => r.id)
      );
      expect(rows.filter((r) => others.includes(r))).toEqual([]);
      for (const section of sectionsOf(id)) {
        expect(
          document.querySelectorAll(`[data-settings-section="${section.id}"]`)
        ).toHaveLength(1);
      }
    }
  );

  it("counts device updates waiting on the Access tab", async () => {
    renderAt("");
    // The mock starts with one failed and one pending device update.
    await waitFor(() =>
      expect(tab("Access")).toHaveAccessibleName(/2 device updates waiting/)
    );
  });
});

describe("Settings focus links", () => {
  it("scrolls to the focused row, highlights it and drops focus from the URL", async () => {
    const { router } = renderAt("/monitoring?focus=sample-interval");
    await screen.findByRole("switch", { name: "Performance mode" });
    const row = document.querySelector('[data-settings-row="sample-interval"]');
    await waitFor(() => expect(row?.scrollIntoView).toHaveBeenCalled());
    expect(row).toHaveAttribute("data-flash");
    await waitFor(() => expect(router.state.location.search).toBe(""));
  });

  it("ignores a focus id that is not on the page", async () => {
    const { router } = renderAt("/history?focus=nope");
    await screen.findByRole("heading", { name: "Clear history" });
    await waitFor(() => expect(router.state.location.search).toBe(""));
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("Settings regrouped rows", () => {
  it("Appearance is a segmented control that writes the choice", async () => {
    const { transport, user } = renderAt("/general");
    const group = await screen.findByRole("radiogroup", { name: "Appearance" });
    await user.click(within(group).getByRole("radio", { name: "Dark" }));
    await waitFor(() =>
      expect(transport.calls).toContainEqual({
        command: "update_settings",
        args: [{ general: { appearance: "dark" } }],
      })
    );
  });

  it("Show menu-bar icon lives in Menu bar and locks the rest when off", async () => {
    const { transport, user } = renderAt("/menu-bar");
    const icon = await screen.findByRole("switch", {
      name: "Show menu-bar icon",
    });
    expect(icon).toBeChecked();
    await user.click(icon);
    await waitFor(() =>
      expect(transport.calls).toContainEqual({
        command: "update_settings",
        args: [{ general: { show_menu_bar: false } }],
      })
    );
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Show power in the menu bar" })
      ).toBeDisabled()
    );
    expect(
      screen.getByRole("combobox", { name: "CPU separate item" })
    ).toBeDisabled();
    expect(
      screen.getByText("Turn on Show menu-bar icon to change what it shows.")
    ).toBeInTheDocument();
  });

  it("nests Install updates under Check for updates and locks it while off", async () => {
    const { transport, user } = renderAt("/about");
    const check = await screen.findByRole("switch", {
      name: "Check for updates automatically",
    });
    const install = screen.getByRole("switch", {
      name: "Install updates automatically",
    });
    expect(install).toBeEnabled();
    await user.click(check);
    await waitFor(() => expect(install).toBeDisabled());
    expect(
      screen.getByText("Needs Check for updates automatically.")
    ).toBeInTheDocument();
    expect(transport.calls).toContainEqual({
      command: "update_settings",
      args: [{ general: { check_updates: false } }],
    });
  });

  it("Clear history confirms before clearing", async () => {
    const { transport, user } = renderAt("/history");
    const clear = await screen.findByRole("button", { name: "Clear history…" });
    await waitFor(() => expect(clear).toBeEnabled());
    await user.click(clear);
    const dialog = await screen.findByRole("alertdialog", {
      name: "Clear history?",
    });
    expect(transport.calls.map((c) => c.command)).not.toContain(
      "clear_history"
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Clear history" })
    );
    await waitFor(() =>
      expect(transport.calls.map((c) => c.command)).toContain("clear_history")
    );
  });
});
