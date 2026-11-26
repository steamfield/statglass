/**
 * Settings search as pure functions: which catalog rows a query matches,
 * grouped by tab, and the CSS that shows only those rows when each matched
 * tab's real panels render inside the results. The panels stay the shared
 * components, so hiding, flattening and hairline fixes are done by
 * selectors over their `data-settings-*` tags rather than by props.
 */

import { SETTINGS_TABS, type SettingsTabId } from "~/lib/settings-links";
import { type CatalogSection, sectionsOf } from "./catalog";

/** The matches on one tab: its sections and rows, in catalog order. */
export interface SettingsMatch {
  readonly tab: SettingsTabId;
  readonly sectionIds: readonly string[];
  readonly rowIds: readonly string[];
}

/** The attribute on the element that holds every search result group. */
export const RESULTS_ATTR = "data-settings-results";

/** The attribute on one tab's group of results, valued with the tab id. */
export const GROUP_ATTR = "data-search-group";

const SCOPE = `[${RESULTS_ATTR}]`;

/** A section's bordered panel: the element straight after its title. */
const PANEL = `${SCOPE} [data-settings-section] > h2 + div`;

/**
 * Rows that wrap a field label and their own bordered sub-rows (the menu-bar
 * blocks). When one is the last thing showing in its panel, its last sub-row
 * draws the hairline the panel's border already draws.
 */
const BLOCK_ROW_IDS = ["menu-bar-values", "menu-bar-items"] as const;

/** A SettingsRow indented under the row it depends on; results show it flat. */
const NESTED_ROW = "[data-settings-row][data-nested]";
const FLAT_ROW_PADDING = "calc(var(--spacing) * 4)";

/** The lower-case words of a query; empty when it is blank. */
function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** The rows of one section that hold every term in their searchable text. */
function matchingRowIds(
  section: CatalogSection,
  tabLabel: string,
  terms: readonly string[]
): string[] {
  return section.rows
    .filter((row) => {
      const text =
        `${row.label} ${row.keywords} ${section.title} ${tabLabel}`.toLowerCase();
      return terms.every((term) => text.includes(term));
    })
    .map((row) => row.id);
}

/** What one tab holds for the query, or null when nothing on it matches. */
function matchTab(
  tab: (typeof SETTINGS_TABS)[number],
  terms: readonly string[]
): SettingsMatch | null {
  const sectionIds: string[] = [];
  const rowIds: string[] = [];
  for (const section of sectionsOf(tab.id)) {
    const rows = matchingRowIds(section, tab.label, terms);
    if (rows.length === 0) continue;
    sectionIds.push(section.id);
    rowIds.push(...rows);
  }
  return rowIds.length === 0 ? null : { tab: tab.id, sectionIds, rowIds };
}

/**
 * The catalog rows a query finds, grouped by tab in tab order. A row matches
 * when every whitespace-separated term occurs, ignoring case, in its label,
 * keywords, section title or tab label. A blank query matches nothing.
 */
export function matchSettings(query: string): SettingsMatch[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  return SETTINGS_TABS.map((tab) => matchTab(tab, terms)).filter(
    (match): match is SettingsMatch => match !== null
  );
}

/** How many rows the matches name, before knowing which of them render. */
export function matchedRowCount(matches: readonly SettingsMatch[]): number {
  return matches.reduce((count, match) => count + match.rowIds.length, 0);
}

/** A selector list naming each matched row by `attr`. */
function matchedRowsSelector(
  matches: readonly SettingsMatch[],
  attr = "data-settings-row"
): string {
  return matches
    .flatMap((match) => match.rowIds)
    .map((id) => `[${attr}="${id}"]`)
    .join(",");
}

/**
 * The stylesheet that turns matched tabs' panels into search results, scoped
 * to the `RESULTS_ATTR` element. It hides every unmatched row; any section or
 * tab group holding no rendered matched row (a matched row can be absent,
 * like Network history without per-app network); flattens nested rows; and
 * drops the bottom hairline from whatever now shows last in a panel. The first
 * and last child showing take the panel's corner radius, so a filled child
 * (the menu-bar preview) doesn't draw square corners over it. Untagged
 * context (the menu-bar preview, notes) keeps showing in a shown section;
 * context tied to a row by `data-settings-part` (paired devices, pending
 * device updates) shows only with that row. Empty matches give an empty sheet.
 */
export function searchStyles(matches: readonly SettingsMatch[]): string {
  if (matches.length === 0) return "";
  const rows = matchedRowsSelector(matches);
  const parts = matchedRowsSelector(matches, "data-settings-part");
  // A panel child that stays visible: a matched row or untagged context.
  // `:has()` can't nest, so "holds a matched row" is the whole test for a
  // section or group; rows only ever live in their own section.
  const shown = `:is(${rows},${parts},:not([data-settings-row],[data-settings-part]))`;
  const lastShown = `:not(:has(~ ${shown}))`;
  const firstShown = `:not(${shown} ~ *)`;
  const blocks = BLOCK_ROW_IDS.map((id) => `[data-settings-row="${id}"]`).join(
    ","
  );
  return [
    `${SCOPE} [data-settings-row]:not(${rows}){display:none}`,
    `${SCOPE} [data-settings-part]:not(${parts}){display:none}`,
    `${SCOPE} [data-settings-section]:not(:has(${rows})){display:none}`,
    `${SCOPE} [${GROUP_ATTR}]:not(:has(${rows})){display:none}`,
    `${SCOPE} ${NESTED_ROW}{padding-left:${FLAT_ROW_PADDING}}`,
    `${SCOPE} ${NESTED_ROW}::before{content:none}`,
    `${PANEL} > ${lastShown}{border-bottom-width:0}`,
    `${PANEL} > :is(${blocks})${lastShown} > :last-child{border-bottom-width:0}`,
    `${PANEL} > ${shown}${firstShown}{border-top-left-radius:inherit;border-top-right-radius:inherit}`,
    `${PANEL} > ${shown}${lastShown}{border-bottom-left-radius:inherit;border-bottom-right-radius:inherit}`,
  ].join("\n");
}
