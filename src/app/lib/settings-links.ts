/**
 * Where Settings lives in the dashboard: one tab per path segment
 * (`/dashboard/settings/<tab>`) and an optional row to bring into view
 * (`?focus=<row id>`). A path segment survives a cold window open, since Rust
 * loads the route as the new window's URL path; the bare path is General.
 */

/** The Settings tabs, in display order. General is the default. */
export const SETTINGS_TABS = [
  { id: "general", label: "General" },
  { id: "menu-bar", label: "Menu bar" },
  { id: "monitoring", label: "Monitoring" },
  { id: "history", label: "History" },
  { id: "access", label: "Access" },
  { id: "about", label: "About" },
] as const;

/** One Settings tab's id, as it appears in the path. */
export type SettingsTabId = (typeof SETTINGS_TABS)[number]["id"];

const BASE = "/dashboard/settings";

function isSettingsTab(value: string | undefined): value is SettingsTabId {
  return SETTINGS_TABS.some((tab) => tab.id === value);
}

/** The link to one Settings tab, optionally focused on one row. */
export function settingsHref(tab: SettingsTabId, focus?: string): string {
  const path = `${BASE}/${tab}`;
  return focus ? `${path}?${new URLSearchParams({ focus })}` : path;
}

/** True for the Settings page on any tab. */
export function isSettingsPath(pathname: string): boolean {
  return pathname === BASE || pathname.startsWith(`${BASE}/`);
}

/**
 * The tab and focus row a location names. A missing or unknown tab is
 * General; an empty focus is none.
 */
export function parseSettingsLocation(
  pathname: string,
  search: string
): { tab: SettingsTabId; focus: string | null } {
  const segment = isSettingsPath(pathname)
    ? pathname.slice(BASE.length + 1).split("/")[0]
    : undefined;
  return {
    tab: isSettingsTab(segment) ? segment : "general",
    focus: new URLSearchParams(search).get("focus") || null,
  };
}
