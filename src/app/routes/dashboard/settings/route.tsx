import { useLocation } from "react-router";
import { PageHeader } from "~/components/page-header";
import { parseSettingsLocation } from "~/lib/settings-links";
import { TabContent } from "./_components/tab-content";

/**
 * Settings (plan 4.15), one tab per path segment. Every control reads the
 * Rust-owned settings mirror and writes one `update_settings` patch (D-050);
 * nothing is kept locally, so another window's change shows here at once.
 * Lane a adds the tab bar, sticky offsets and focus links
 * (plans/settings-tabs.md).
 */
export default function SettingsRoute() {
  const { pathname, search } = useLocation();
  const { tab } = parseSettingsLocation(pathname, search);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Settings" />
      <div data-enter-group className="flex max-w-[760px] flex-col gap-5">
        <TabContent tab={tab} />
      </div>
    </div>
  );
}
