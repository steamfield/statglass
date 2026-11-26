import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router";
import { PageHeader } from "~/components/page-header";
import {
  parseSettingsLocation,
  type SettingsTabId,
  settingsHref,
} from "~/lib/settings-links";
import { cn } from "~/lib/utils";
import { firstShownMatch, SearchResults } from "./_components/search-results";
import { SettingsSearch } from "./_components/settings-search";
import {
  SETTINGS_TABPANEL_ID,
  SettingsTabs,
  settingsTabTriggerId,
} from "./_components/settings-tabs";
import { TabContent } from "./_components/tab-content";
import { useFocusRow } from "./_hooks/use-focus-row";
import { RESULTS_ATTR } from "./_lib/search";

/** The single 760 px column the tab's panels or the search results sit in. */
const BODY = "mt-5 flex max-w-[760px] flex-col gap-5";

/**
 * Settings (plan 4.15), one tab per path segment and an optional
 * `?focus=<row id>` to bring a row into view. Every control reads the
 * Rust-owned settings mirror and writes one `update_settings` patch (D-050);
 * nothing is kept locally, so another window's change shows here at once.
 * A search query (route state, not in the URL) replaces the tab's panels
 * with the matching rows of every tab and dims the tab bar until cleared.
 * The tab bar sticks under the page header, and `--settings-sticky-top` on the
 * root tells sticky content below (the menu-bar preview) where both end.
 */
export default function SettingsRoute() {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const { tab, focus } = parseSettingsLocation(pathname, search);
  const [headerRef, headerHeight] = useBorderBoxHeight<HTMLElement>();
  const [tabsRef, tabsHeight] = useBorderBoxHeight<HTMLDivElement>();

  const [query, setQuery] = useTabSearch(tab, focus);
  const searching = query.trim() !== "";
  const searchRef = useRef<HTMLInputElement>(null);
  const [panelRef, focusPanel] = usePendingFocus<HTMLDivElement>();

  const suggest = (next: string) => {
    setQuery(next);
    searchRef.current?.focus();
  };
  const openTab = () => {
    setQuery("");
    focusPanel();
  };

  // Return in the field opens the first result that shows, focused on it,
  // as "Open in" does; with nothing showing it does nothing.
  const openFirst = () => {
    const root = document.querySelector<HTMLElement>(`[${RESULTS_ATTR}]`);
    const first = firstShownMatch(query, root);
    if (!first) return;
    setQuery("");
    void navigate(settingsHref(first.tab, first.row));
  };

  const selectTab = (next: SettingsTabId) => {
    setQuery("");
    // Leaving search for the tab already open adds no history entry.
    if (next !== tab) void navigate(settingsHref(next));
  };
  const clearFocus = useCallback(
    () => void navigate(settingsHref(tab), { replace: true }),
    [navigate, tab]
  );
  useFocusRow(focus, clearFocus);

  const stickyTop = {
    "--settings-sticky-top": `${headerHeight + tabsHeight}px`,
  } as CSSProperties;
  return (
    <div className="flex flex-col" style={stickyTop}>
      <PageHeader
        title="Settings"
        headerRef={headerRef}
        actions={
          <SettingsSearch
            value={query}
            onChange={setQuery}
            inputRef={searchRef}
            onEnter={openFirst}
          />
        }
      />
      <div
        ref={tabsRef}
        className={cn(
          "sticky z-10",
          // Only the tabs dim; the band stays opaque over content scrolling
          // under it. A click on any tab still leaves search for that tab.
          searching &&
            "[&_[role=tablist]:hover]:opacity-100 [&_[role=tablist]]:opacity-50 [&_[role=tablist]]:transition-opacity"
        )}
        style={{ top: `${headerHeight}px` }}
      >
        <SettingsTabs
          value={tab}
          onValueChange={selectTab}
          searching={searching}
        />
      </div>
      {searching ? (
        <div data-enter-group className={BODY}>
          <SearchResults query={query} onSuggest={suggest} onOpen={openTab} />
        </div>
      ) : (
        <div
          ref={panelRef}
          role="tabpanel"
          tabIndex={-1}
          id={SETTINGS_TABPANEL_ID}
          aria-labelledby={settingsTabTriggerId(tab)}
          data-enter-group
          className={cn(BODY, "outline-none")}
        >
          <TabContent tab={tab} />
        </div>
      )}
    </div>
  );
}

/**
 * The search query, kept with the tab it was typed on. When the tab changes
 * from anywhere (a reason link, the sidebar, "Open in"), or a link asks to
 * focus a row (which may be on this tab, hidden by the results), the query
 * resets during that render, so the tab panel is there to scroll to.
 */
function useTabSearch(tab: SettingsTabId, focus: string | null) {
  const [typed, setTyped] = useState({ tab, focus, query: "" });
  // Only a new focus resets: typing while one is still being looked for stays.
  const stale = typed.tab !== tab || (focus !== null && focus !== typed.focus);
  if (stale) setTyped({ tab, focus, query: "" });
  const query = stale ? "" : typed.query;
  const setQuery = (next: string) => setTyped({ tab, focus, query: next });
  return [query, setQuery] as const;
}

/**
 * A ref and a request to focus its element once it has rendered. "Open in"
 * swaps the results for the tab panel in the same update, so the panel only
 * exists on the render after the request.
 */
function usePendingFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!pending || !ref.current) return;
    // The focus link scrolls its row into view; focusing must not undo that.
    ref.current.focus({ preventScroll: true });
    setPending(false);
  }, [pending]);
  return [ref, () => setPending(true)] as const;
}

/**
 * The border-box height of the element on the returned ref, in px, kept
 * current with a ResizeObserver. `useElementSize` reports the content box,
 * which leaves out the header's padding and hairline that a sticky offset
 * has to clear.
 */
function useBorderBoxHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setHeight(el.offsetHeight);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, height] as const;
}
