/**
 * What Settings contains: every section and row each tab shows, in order,
 * with the words people search for. Panels tag their rows with
 * these ids (`data-settings-row`), so search, deep links and the catalog
 * test all agree on one list.
 */

import type { SettingsTabId } from "~/lib/settings-links";

/** One searchable row: its `data-settings-row` id, its label and synonyms. */
export interface CatalogRow {
  readonly id: string;
  readonly label: string;
  /** Lower-case words people type for this row that its label lacks. */
  readonly keywords: string;
}

/** One panel on a tab: its `data-settings-section` id, title and rows. */
export interface CatalogSection {
  readonly id: string;
  readonly tab: SettingsTabId;
  readonly title: string;
  readonly rows: readonly CatalogRow[];
}

/** Every Settings section in tab order, then in order on its tab. */
export const SETTINGS_CATALOG: readonly CatalogSection[] = [
  {
    id: "startup",
    tab: "general",
    title: "Startup",
    rows: [
      {
        id: "launch-at-login",
        label: "Launch at login",
        keywords: "startup start boot open login items autostart",
      },
      {
        id: "show-in-dock",
        label: "Show in Dock",
        keywords: "dock app icon switcher command tab",
      },
    ],
  },
  {
    id: "appearance",
    tab: "general",
    title: "Appearance",
    rows: [
      {
        id: "appearance",
        label: "Appearance",
        keywords: "dark mode light mode theme color colour system",
      },
    ],
  },
  {
    id: "units",
    tab: "general",
    title: "Units",
    rows: [
      {
        id: "temperature-unit",
        label: "Temperature",
        keywords: "celsius fahrenheit degrees °c °f thermal",
      },
      {
        id: "network-unit",
        label: "Network rate",
        keywords: "bits bytes speed bandwidth mbps throughput",
      },
      {
        id: "memory-unit",
        label: "Memory",
        keywords: "gibibyte binary decimal ram gb gib bytes",
      },
    ],
  },
  {
    id: "menu-bar",
    tab: "menu-bar",
    title: "Menu bar",
    rows: [
      {
        id: "show-menu-bar-icon",
        label: "Show menu-bar icon",
        keywords: "status item tray hide menubar visible",
      },
      {
        id: "menu-bar-bars",
        label: "Bars",
        keywords: "menubar tray graph usage meters cpu gpu memory pressure",
      },
      {
        id: "menu-bar-values",
        label: "Values after the bars",
        keywords:
          "menubar tray readout text number cpu gpu memory temperature power network disk battery",
      },
      {
        id: "menu-bar-items",
        label: "Separate items",
        keywords: "menubar tray own icon status item graph per-core reorder",
      },
    ],
  },
  {
    id: "modules",
    tab: "monitoring",
    title: "Modules",
    rows: [
      { id: "module-cpu", label: "CPU", keywords: "module collect processor" },
      { id: "module-gpu", label: "GPU", keywords: "module collect graphics" },
      { id: "module-memory", label: "Memory", keywords: "module collect ram" },
      {
        id: "module-power",
        label: "Power & Sensors",
        keywords: "module collect temperature fans watts thermal",
      },
      {
        id: "module-network",
        label: "Network",
        keywords: "module collect bandwidth wifi ethernet",
      },
      {
        id: "module-disk",
        label: "Disk",
        keywords: "module collect drive storage ssd",
      },
      {
        id: "module-battery",
        label: "Battery",
        keywords: "module collect charge health cycles",
      },
    ],
  },
  {
    id: "sampling",
    tab: "monitoring",
    title: "Sampling",
    rows: [
      {
        id: "performance-mode",
        label: "Performance mode",
        keywords: "low power battery cpu usage energy save animations",
      },
      {
        id: "sample-interval",
        label: "Sample interval",
        keywords:
          "refresh rate frequency update speed polling how often seconds",
      },
      {
        id: "slow-on-battery",
        label: "Slow down on battery",
        keywords: "battery power saving unplugged laptop",
      },
    ],
  },
  {
    id: "history",
    tab: "history",
    title: "History",
    rows: [
      {
        id: "keep-history",
        label: "Keep history",
        keywords: "days retention keep data how long duration",
      },
      {
        id: "history-size-limit",
        label: "History size limit",
        keywords: "disk space storage size cap maximum",
      },
      {
        id: "network-history",
        label: "Network history",
        keywords: "apps network usage per app bandwidth record",
      },
    ],
  },
  {
    id: "clear-history",
    tab: "history",
    title: "Clear history",
    rows: [
      {
        id: "clear-history",
        label: "Clear history",
        keywords: "delete erase reset wipe remove data on disk",
      },
    ],
  },
  {
    id: "remote",
    tab: "access",
    title: "Other Macs",
    rows: [
      {
        id: "remote-monitoring",
        label: "Allow remote monitoring",
        keywords: "ssh other macs network remote access share",
      },
    ],
  },
  {
    id: "iphones",
    tab: "access",
    title: "iPhones",
    rows: [
      {
        id: "iphone-access",
        label: "iPhone access",
        keywords: "iphone phone mobile qr pair ios paired devices list revoke",
      },
      {
        id: "iphone-host-list",
        label: "Host list on iPhone",
        keywords: "iphone hosts share sync update phone",
      },
      {
        id: "device-access",
        label: "Device access on other hosts",
        keywords: "pending device updates revoke install retry iphone",
      },
    ],
  },
  {
    id: "command-line",
    tab: "access",
    title: "Command line",
    rows: [
      {
        id: "command-line-access",
        label: "Allow command-line access",
        keywords: "terminal shell cli agent read history",
      },
      {
        id: "statglass-command",
        label: "statglass command",
        keywords: "path install binary local bin terminal cli",
      },
      {
        id: "coding-agents",
        label: "Coding agents",
        keywords: "claude code agent skill install codex ai",
      },
    ],
  },
  {
    id: "updates",
    tab: "about",
    title: "Updates",
    rows: [
      {
        id: "version",
        label: "Version",
        keywords: "version release check now upgrade latest about",
      },
      {
        id: "check-updates",
        label: "Check for updates automatically",
        keywords: "upgrade update automatic release",
      },
      {
        id: "install-updates",
        label: "Install updates automatically",
        keywords: "upgrade install restart automatic",
      },
    ],
  },
  {
    id: "feedback",
    tab: "about",
    title: "Feedback",
    rows: [
      {
        id: "feedback",
        label: "Feedback & issues",
        keywords: "bug report issue github help support problem system info",
      },
      {
        id: "support",
        label: "Support StatGlass",
        keywords: "github star open source",
      },
    ],
  },
];

/** The catalog sections one tab shows, in order. */
export function sectionsOf(tab: SettingsTabId): readonly CatalogSection[] {
  return SETTINGS_CATALOG.filter((section) => section.tab === tab);
}
