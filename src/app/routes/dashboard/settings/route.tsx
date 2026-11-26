import {
  type CSSProperties,
  useCallback,
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
import {
  SETTINGS_TABPANEL_ID,
  SettingsTabs,
  settingsTabTriggerId,
} from "./_components/settings-tabs";
import { TabContent } from "./_components/tab-content";
import { useFocusRow } from "./_hooks/use-focus-row";

/**
 * Settings (plan 4.15), one tab per path segment and an optional
 * `?focus=<row id>` to bring a row into view. Every control reads the
 * Rust-owned settings mirror and writes one `update_settings` patch (D-050);
 * nothing is kept locally, so another window's change shows here at once.
 * The tab bar sticks under the page header, and `--settings-sticky-top` on the
 * root tells sticky content below (the menu-bar preview) where both end.
 */
export default function SettingsRoute() {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const { tab, focus } = parseSettingsLocation(pathname, search);
  const [headerRef, headerHeight] = useBorderBoxHeight<HTMLElement>();
  const [tabsRef, tabsHeight] = useBorderBoxHeight<HTMLDivElement>();

  const selectTab = (next: SettingsTabId) => void navigate(settingsHref(next));
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
      <PageHeader title="Settings" headerRef={headerRef} />
      <div
        ref={tabsRef}
        className="sticky z-10"
        style={{ top: `${headerHeight}px` }}
      >
        <SettingsTabs value={tab} onValueChange={selectTab} />
      </div>
      <div
        role="tabpanel"
        id={SETTINGS_TABPANEL_ID}
        aria-labelledby={settingsTabTriggerId(tab)}
        data-enter-group
        className="mt-5 flex max-w-[760px] flex-col gap-5"
      >
        <TabContent tab={tab} />
      </div>
    </div>
  );
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
