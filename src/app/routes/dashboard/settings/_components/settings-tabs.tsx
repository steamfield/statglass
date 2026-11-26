/**
 * The Settings tab bar: one Radix tab per Settings tab, a 2 px underline that
 * slides to the active one, and the count of device updates waiting on Access.
 * Only the list lives here; the route renders the panel and makes the bar
 * sticky.
 */
import { Tabs as TabsPrimitive } from "radix-ui";
import { useLayoutEffect, useRef } from "react";
import { SETTINGS_TABS, type SettingsTabId } from "~/lib/settings-links";
import { useDeviceIntents } from "../_hooks/use-device-intents";

/** The id of the element the route renders the active tab's panels in. */
export const SETTINGS_TABPANEL_ID = "settings-tabpanel";

/** The stable DOM id of one tab's trigger, for the panel's `aria-labelledby`. */
export function settingsTabTriggerId(tab: SettingsTabId): string {
  return `settings-tab-${tab}`;
}

/**
 * A tab's accessible name when it shows a waiting count ("Access, 2 device
 * updates waiting"); undefined leaves the visible label as the name. It is
 * an `aria-label` because the badge is hidden from assistive tech, and name
 * computation over the visible spans would put a space before the comma.
 */
function waitingName(label: string, waiting: number): string | undefined {
  if (waiting === 0) return undefined;
  const updates = waiting === 1 ? "update" : "updates";
  return `${label}, ${waiting} device ${updates} waiting`;
}

/**
 * The tab bar for Settings, controlled by `value`. Arrow keys move the
 * selection and activate the tab they land on.
 */
export function SettingsTabs({
  value,
  onValueChange,
}: {
  value: SettingsTabId;
  onValueChange: (tab: SettingsTabId) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const underlineRef = useRef<HTMLSpanElement>(null);
  const waiting = useDeviceIntents().data?.length ?? 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the selection or the Access count changes the trigger widths
  useLayoutEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>(
      "[data-state=active]"
    );
    const underline = underlineRef.current;
    if (!active || !underline) return;
    underline.style.width = `${active.offsetWidth}px`;
    underline.style.transform = `translateX(${active.offsetLeft}px)`;
  }, [value, waiting]);

  return (
    <TabsPrimitive.Root
      value={value}
      onValueChange={(next) => onValueChange(next as SettingsTabId)}
      activationMode="automatic"
      className="-mx-3 border-border-subtle border-b bg-background px-3 sm:-mx-6 sm:px-6"
    >
      <TabsPrimitive.List
        ref={listRef}
        aria-label="Settings sections"
        className="relative flex gap-5 overflow-x-auto"
      >
        {SETTINGS_TABS.map((tab) => (
          <TabsPrimitive.Trigger
            key={tab.id}
            value={tab.id}
            id={settingsTabTriggerId(tab.id)}
            aria-controls={SETTINGS_TABPANEL_ID}
            aria-label={
              tab.id === "access" ? waitingName(tab.label, waiting) : undefined
            }
            className="flex h-9 shrink-0 items-center gap-1.5 font-medium text-body text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:text-foreground"
          >
            {tab.label}
            {tab.id === "access" && waiting > 0 && (
              <WaitingCount count={waiting} />
            )}
          </TabsPrimitive.Trigger>
        ))}
        <span
          ref={underlineRef}
          aria-hidden
          className="pointer-events-none absolute bottom-0 left-0 h-0.5 bg-foreground motion-safe:transition-transform motion-safe:duration-(--motion-fast) motion-safe:ease-out"
        />
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  );
}

/** The bordered count after the Access label; the tab's name says it aloud. */
function WaitingCount({ count }: { count: number }) {
  return (
    <span
      aria-hidden
      className="figures rounded-full border border-border px-1.5 font-normal text-caption text-fg-subtle leading-4"
    >
      {count}
    </span>
  );
}
