import { act, screen, waitFor, within } from "@testing-library/react";
import { type SettingsTabId, settingsHref } from "~/lib/settings-links";
import {
  type RenderWithProvidersOptions,
  renderWithProviders,
} from "../../../../../tests/test-utils";
import { SETTINGS_CATALOG } from "./_lib/catalog";
import SettingsRoute from "./route";

const renderOn = (
  tab: SettingsTabId,
  options: RenderWithProvidersOptions = {}
) =>
  renderWithProviders(<SettingsRoute />, {
    route: settingsHref(tab),
    ...options,
  });

const searchField = () =>
  screen.getByRole("textbox", { name: "Search settings" });

/** Types a query into the search field once the page has loaded. */
async function search(
  user: ReturnType<typeof renderOn>["user"],
  query: string
) {
  await screen.findAllByRole("heading", { level: 2 });
  await user.type(searchField(), query);
}

const row = (id: string) =>
  document.querySelector(`[data-settings-row="${id}"]`);

const rowsOnPage = () =>
  [...document.querySelectorAll("[data-settings-row]")].map(
    (el) => el.getAttribute("data-settings-row") ?? ""
  );

/** Every catalog row id not on `tab`. */
const rowsOffTab = (tab: SettingsTabId) =>
  SETTINGS_CATALOG.filter((s) => s.tab !== tab).flatMap((s) =>
    s.rows.map((r) => r.id)
  );

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe("Settings search", () => {
  it("shows the Appearance row with its working control for “dark”", async () => {
    const { user, transport } = renderOn("monitoring");
    await search(user, "dark");

    expect(await screen.findByRole("status")).toHaveTextContent(
      "1 setting matches “dark”"
    );
    expect(row("appearance")).toBeVisible();
    expect(row("launch-at-login")).not.toBeVisible();
    expect(
      rowsOnPage().filter((id) => rowsOffTab("general").includes(id))
    ).toEqual([]);

    const group = screen.getByRole("radiogroup", { name: "Appearance" });
    await user.click(within(group).getByRole("radio", { name: "Dark" }));
    await waitFor(() =>
      expect(transport.calls).toContainEqual({
        command: "update_settings",
        args: [{ general: { appearance: "dark" } }],
      })
    );
  });

  it("finds Sample interval for “refresh”", async () => {
    const { user } = renderOn("general");
    await search(user, "refresh");
    await waitFor(() => expect(row("sample-interval")).toBeVisible());
    expect(row("performance-mode")).not.toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "1 setting matches “refresh”"
    );
  });

  it("finds Allow remote monitoring for “ssh”", async () => {
    const { user } = renderOn("general");
    await search(user, "ssh");
    expect(
      await screen.findByRole("switch", { name: "Allow remote monitoring" })
    ).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "1 setting matches “ssh”"
    );
  });

  it("changes a unit in place: “fahrenheit”, then °F", async () => {
    const { user, transport } = renderOn("about");
    await search(user, "fahrenheit");
    await user.click(await screen.findByRole("radio", { name: "°F" }));
    await waitFor(() =>
      expect(transport.calls).toContainEqual({
        command: "update_settings",
        args: [{ units: { temperature: "fahrenheit" } }],
      })
    );
  });

  it("counts the matches in a status line", async () => {
    const { user } = renderOn("general");
    await search(user, "iphone");
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "3 settings match “iphone”"
      )
    );
  });

  it("says when nothing matches and offers queries to try", async () => {
    const { user } = renderOn("general");
    await search(user, "zebra");
    expect(screen.getByRole("status")).toHaveTextContent(
      "No settings match “zebra”."
    );
    expect(
      screen.getByText(
        "Alert rules and destinations are on the Alerts page. Per-host options are on Hosts."
      )
    ).toBeInTheDocument();
    expect(rowsOnPage()).toEqual([]);

    const chips = ["appearance", "interval", "history", "iphone"];
    for (const chip of chips) {
      expect(screen.getByRole("button", { name: chip })).toBeInTheDocument();
    }
    await user.click(screen.getByRole("button", { name: "interval" }));
    expect(searchField()).toHaveValue("interval");
    expect(searchField()).toHaveFocus();
    await waitFor(() => expect(row("sample-interval")).toBeVisible());
  });

  it("returns to the open tab on Escape and on the clear button", async () => {
    const { user, router } = renderOn("history");
    await search(user, "dark");
    expect(screen.queryByRole("tabpanel")).toBeNull();

    await user.keyboard("{Escape}");
    expect(searchField()).toHaveValue("");
    expect(
      await screen.findByRole("heading", { name: "Clear history" })
    ).toBeInTheDocument();
    expect(screen.getByRole("tabpanel")).toBeInTheDocument();

    await user.type(searchField(), "dark");
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(searchField()).toHaveValue("");
    expect(
      await screen.findByRole("heading", { name: "Clear history" })
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(settingsHref("history"));
  });

  it.each(["{Meta>}f{/Meta}", "{Control>}f{/Control}"])(
    "focuses and selects the field on %s",
    async (shortcut) => {
      const { user } = renderOn("general");
      await search(user, "dark");
      (document.activeElement as HTMLElement | null)?.blur();

      await user.keyboard(shortcut);
      const field = searchField() as HTMLInputElement;
      expect(field).toHaveFocus();
      expect([field.selectionStart, field.selectionEnd]).toEqual([0, 4]);
    }
  );

  it("keeps Ctrl+F in the field for the cursor, and ignores ⌘⇧F", async () => {
    const { user } = renderOn("general");
    await search(user, "dark");
    const field = searchField() as HTMLInputElement;
    field.setSelectionRange(4, 4);
    await user.keyboard("{Control>}f{/Control}");
    expect([field.selectionStart, field.selectionEnd]).toEqual([4, 4]);

    act(() => field.blur());
    await user.keyboard("{Meta>}{Shift>}f{/Shift}{/Meta}");
    expect(field).not.toHaveFocus();
  });

  it("dims the tabs out of the Tab order but keeps them announced", async () => {
    const { user } = renderOn("general");
    await search(user, "dark");
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(6);
    for (const tab of tabs) {
      expect(tab).not.toHaveAttribute("aria-controls");
    }
    // From the field: past its clear button, then into the results.
    await user.tab();
    expect(screen.getByRole("button", { name: "Clear search" })).toHaveFocus();
    await user.tab();
    expect(document.activeElement).not.toHaveAttribute("role", "tab");
    expect(screen.getByRole("status").parentElement).toContainElement(
      document.activeElement as HTMLElement
    );
  });

  it("leaves search when a link changes the tab", async () => {
    const { user, router } = renderOn("general");
    await search(user, "dark");
    await act(() => router.navigate(settingsHref("about")));
    expect(searchField()).toHaveValue("");
    expect(await screen.findByRole("tabpanel")).toBeInTheDocument();

    await act(() => router.navigate(settingsHref("general")));
    expect(searchField()).toHaveValue("");
    expect(
      await screen.findByRole("heading", { name: "Startup" })
    ).toBeVisible();
  });

  it("opens a group's tab focused on its first match and leaves search", async () => {
    const { user, router } = renderOn("general");
    await search(user, "ssh");
    await user.click(
      await screen.findByRole("link", { name: "Open in Access" })
    );
    expect(searchField()).toHaveValue("");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(settingsHref("access"))
    );
    await waitFor(() => expect(screen.getByRole("tabpanel")).toHaveFocus());
    // The focus link is consumed once the row scrolls into view.
    await waitFor(() =>
      expect(row("remote-monitoring")?.scrollIntoView).toHaveBeenCalled()
    );
  });

  it("neither shows nor counts a match its panel leaves out", async () => {
    // Without per-app network the History panel has no Network history row.
    const { user } = renderOn("general", {
      transportOptions: { scenarios: ["no-process-network"] },
    });
    await search(user, "network history");
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "No settings match “network history”."
      )
    );
    expect(row("network-history")).toBeNull();
    // The History group still mounts its panels, hidden with nothing to show.
    expect(
      document.querySelector('[data-search-group="history"]')
    ).not.toBeVisible();
    expect(screen.queryByRole("link", { name: "Open in History" })).toBeNull();
  });
});
