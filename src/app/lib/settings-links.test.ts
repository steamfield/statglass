import {
  isSettingsPath,
  parseSettingsLocation,
  settingsHref,
} from "./settings-links";

describe("parseSettingsLocation", () => {
  it("opens General with no focus on the bare path", () => {
    expect(parseSettingsLocation("/dashboard/settings", "")).toEqual({
      tab: "general",
      focus: null,
    });
  });

  it("reads the tab segment and the focus row", () => {
    expect(
      parseSettingsLocation(
        "/dashboard/settings/menu-bar",
        "?focus=menu-bar-values"
      )
    ).toEqual({ tab: "menu-bar", focus: "menu-bar-values" });
  });

  it("falls back to General for an unknown tab and keeps the focus", () => {
    expect(
      parseSettingsLocation("/dashboard/settings/Settings", "?focus=appearance")
    ).toEqual({ tab: "general", focus: "appearance" });
  });

  it("treats an empty focus as none", () => {
    expect(
      parseSettingsLocation("/dashboard/settings/history", "?focus=")
    ).toEqual({ tab: "history", focus: null });
  });
});

describe("settingsHref", () => {
  it("names the tab as a path segment", () => {
    expect(settingsHref("access")).toBe("/dashboard/settings/access");
  });

  it("adds the row to focus", () => {
    expect(settingsHref("monitoring", "performance-mode")).toBe(
      "/dashboard/settings/monitoring?focus=performance-mode"
    );
  });

  it("round-trips through parseSettingsLocation", () => {
    const [path, search = ""] = settingsHref("about", "version").split("?");
    expect(parseSettingsLocation(path ?? "", `?${search}`)).toEqual({
      tab: "about",
      focus: "version",
    });
  });
});

describe("isSettingsPath", () => {
  it("matches Settings on every tab and nothing else", () => {
    expect(isSettingsPath("/dashboard/settings")).toBe(true);
    expect(isSettingsPath("/dashboard/settings/history")).toBe(true);
    expect(isSettingsPath("/dashboard/settings-extra")).toBe(false);
    expect(isSettingsPath("/dashboard/hosts")).toBe(false);
  });
});
