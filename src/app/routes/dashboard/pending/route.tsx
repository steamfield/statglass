import { useLocation } from "react-router";
import { PageHeader } from "~/components/page-header";
import { MODULE_META } from "~/widgets/lib/module-meta";

const TITLES: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(MODULE_META).map(([id, meta]) => [id, meta.name])
  ),
  timeline: "Timeline",
  processes: "Processes",
  settings: "Settings",
};

/** Dashboard pages that land in phase 5: the title and nothing else yet. */
export default function PendingPageRoute() {
  const page = useLocation().pathname.split("/")[2] ?? "";
  return <PageHeader title={TITLES[page] ?? page} />;
}
