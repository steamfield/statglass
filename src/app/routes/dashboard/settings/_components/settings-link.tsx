/**
 * An inline link inside Settings copy that opens another setting: its tab,
 * scrolled to and flashing its row. Used where a disabled reason names the
 * setting that unlocks it.
 */
import type { ReactNode } from "react";
import { Link } from "react-router";
import { type SettingsTabId, settingsHref } from "~/lib/settings-links";

/** A text link to one Settings row (`row` is its catalog row id). */
export function SettingsLink({
  tab,
  row,
  children,
}: {
  tab: SettingsTabId;
  row: string;
  children: ReactNode;
}) {
  return (
    <Link
      to={settingsHref(tab, row)}
      className="rounded-chip text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </Link>
  );
}
