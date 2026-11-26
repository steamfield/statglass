import { matchedRowCount, matchSettings, searchStyles } from "./search";

describe("matchSettings", () => {
  it("finds a row by a keyword its label lacks", () => {
    expect(matchSettings("dark")).toEqual([
      { tab: "general", sectionIds: ["appearance"], rowIds: ["appearance"] },
    ]);
    expect(matchSettings("refresh")).toEqual([
      {
        tab: "monitoring",
        sectionIds: ["sampling"],
        rowIds: ["sample-interval"],
      },
    ]);
  });

  it("ignores case and needs every term, from any of label, keywords, section and tab", () => {
    // "Network" is the label, "history" the section and tab.
    expect(matchSettings("  NETWORK   History ")).toEqual([
      {
        tab: "history",
        sectionIds: ["history"],
        rowIds: ["network-history"],
      },
    ]);
  });

  it("groups matches by tab in tab order", () => {
    const matches = matchSettings("iphone");
    expect(matches.map((m) => m.tab)).toEqual(["access"]);
    expect(matches[0]?.rowIds).toEqual([
      "iphone-access",
      "device-access",
      "iphone-host-list",
    ]);
    expect(matchSettings("memory").map((m) => m.tab)).toEqual([
      "general",
      "menu-bar",
      "monitoring",
    ]);
  });

  it("matches nothing for a blank query or an unknown word", () => {
    expect(matchSettings("")).toEqual([]);
    expect(matchSettings("   ")).toEqual([]);
    expect(matchSettings("dark zebra")).toEqual([]);
  });

  it("counts every matched row across tabs", () => {
    expect(matchedRowCount(matchSettings("iphone"))).toBe(3);
    expect(matchedRowCount([])).toBe(0);
  });
});

describe("searchStyles", () => {
  const css = searchStyles(matchSettings("network history"));
  const rule = (prefix: string) =>
    css.split("\n").find((line) => line.startsWith(prefix));
  const scope = "[data-settings-results]";
  const matched = '[data-settings-row="network-history"]';

  it("hides every row but the matched ones", () => {
    expect(rule(`${scope} [data-settings-row]:not(`)).toBe(
      `${scope} [data-settings-row]:not(${matched}){display:none}`
    );
  });

  it("hides context tied to a row that didn't match", () => {
    expect(css).toContain(
      `${scope} [data-settings-part]:not([data-settings-part="network-history"]){display:none}`
    );
  });

  it("hides sections and tab groups that hold no rendered matched row", () => {
    expect(css).toContain(
      `${scope} [data-settings-section]:not(:has(${matched})){display:none}`
    );
    expect(css).toContain(
      `${scope} [data-search-group]:not(:has(${matched})){display:none}`
    );
  });

  it("flattens nested rows and drops their connector", () => {
    expect(css).toContain(
      `${scope} [data-settings-row][data-nested]{padding-left:calc(var(--spacing) * 4)}`
    );
    expect(css).toContain(
      `${scope} [data-settings-row][data-nested]::before{content:none}`
    );
  });

  it("drops the hairline under whatever shows last in a panel", () => {
    const lastShown = `:not(:has(~ :is(${matched},[data-settings-part="network-history"],:not([data-settings-row],[data-settings-part]))))`;
    const panel = `${scope} [data-settings-section] > h2 + div`;
    expect(css).toContain(`${panel} > ${lastShown}{border-bottom-width:0}`);
    expect(css).toContain(
      `${panel} > :is([data-settings-row="menu-bar-values"],[data-settings-row="menu-bar-items"])${lastShown} > :last-child{border-bottom-width:0}`
    );
  });

  it("gives the first and last child showing the panel's corners", () => {
    const shown = `:is(${matched},[data-settings-part="network-history"],:not([data-settings-row],[data-settings-part]))`;
    const panel = `${scope} [data-settings-section] > h2 + div`;
    expect(css).toContain(
      `${panel} > ${shown}:not(${shown} ~ *){border-top-left-radius:inherit;border-top-right-radius:inherit}`
    );
    expect(css).toContain(
      `${panel} > ${shown}:not(:has(~ ${shown})){border-bottom-left-radius:inherit;border-bottom-right-radius:inherit}`
    );
  });

  it("names every matched row of every tab", () => {
    const memory = searchStyles(matchSettings("memory"));
    for (const id of ["memory-unit", "menu-bar-bars", "module-memory"]) {
      expect(memory).toContain(`[data-settings-row="${id}"]`);
    }
  });

  it("is empty without matches", () => {
    expect(searchStyles([])).toBe("");
  });
});
