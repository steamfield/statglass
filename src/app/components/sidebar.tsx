import type { Connection } from "@core/live-state";
import { OctagonAlert } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  memo,
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
} from "react";
import { StatGlassMark } from "~/components/statglass-mark";
import { cn } from "~/lib/utils";
import { StatusDot } from "~/widgets/status-dot";

/** Icon paths (24 x 24, 1.5 px stroke). */
const ICONS = {
  overview: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
  timeline: "M22 12h-4l-3 9L9 3l-3 9H2",
  cpu: "M6 6h12v12H6zM9 9h6v6H9zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4",
  gpu: "M3 6h18v12H3zM7 10h3v4H7zM13 10h4M13 14h4M7 18v2M17 18v2",
  memory:
    "M6 19v-3M10 19v-3M14 19v-3M18 19v-3M2 15h20M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM7 9h10",
  power: "M13 2 3 14h9l-1 8 10-12h-9l1-8z",
  network: "M7 3v18M3 7l4-4 4 4M17 21V3M13 17l4 4 4-4",
  disk: "M22 12H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11zM6 16h.01M10 16h.01",
  "disk-space": "M3 3h18v18H3zM13 3v18M3 13h10M13 9h8",
  battery:
    "M3 7h15a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zM22 11v2M6 10v4M10 10v4",
  processes: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  containers: "M3 4h7v7H3zM14 4h7v7h-7zM3 15h7v7H3zM14 15h7v7h-7z",
  widgets: "M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z",
  hosts: "M3 3h18v12H3zM8 21h8M12 15v6",
  alerts:
    "M10.268 21a2 2 0 0 0 3.464 0M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326",
  settings:
    "M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4",
} as const;

export type SidebarIcon = keyof typeof ICONS;

export interface SidebarEntry {
  /** Stable id, also what `active` matches ("overview", "cpu"). */
  id: string;
  /** Route the entry opens, "/dashboard/cpu". */
  href: string;
  label: string;
  icon: SidebarIcon;
  /** Live value ("18%", "14.8W"); omitted for disabled modules. */
  value?: string | undefined;
  /** The user switched the module off: listed dimmed, without a value. */
  disabled?: boolean;
  /** Something here needs the user ("2 hosts need updates"); shown as a count. */
  attention?: { count: number; label: string } | undefined;
  /** Work in progress ("Scan running"); shown as a dot in the value slot. */
  busy?: { label: string } | undefined;
}

export interface SidebarStatus {
  /** Effective base tick, ms. */
  intervalMs: number;
  paused: boolean;
  onBattery: boolean;
  /** No frame for three intervals while not paused (plan 4.17). */
  stale?: boolean;
  connection?: Connection;
  /** Accurate remote-host label when viewing a disconnected remote host. */
  remoteStatus?: {
    readonly label: string;
    readonly tone: "idle" | "error";
  };
}

export interface SidebarProps {
  /** Entry groups separated by hairlines, with optional headings. */
  groups: readonly {
    id: string;
    label?: string | undefined;
    entries: readonly SidebarEntry[];
  }[];
  /** Id of the current entry. */
  active: string;
  status: SidebarStatus;
  /** App version, "0.4.0". */
  version: string;
  /** Called instead of following the href, so the router can navigate. */
  onNavigate?: ((href: string) => void) | undefined;
  /** Quiet action row above the footer divider (Feedback button). */
  footerAction?: ReactNode;
  /** A second footer line under the sampling state (the Performance mode marker). */
  footerNote?: ReactNode;
  hostSwitcher?: ReactNode;
}

function intervalLabel(ms: number): string {
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
}

function SidebarItem({
  entry,
  current,
  onNavigate,
}: {
  entry: SidebarEntry;
  current: boolean;
  onNavigate?: ((href: string) => void) | undefined;
}) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!onNavigate) return;
    e.preventDefault();
    onNavigate(entry.href);
  };
  return (
    <a
      href={entry.href}
      title={entry.label}
      aria-current={current ? "page" : undefined}
      data-sidebar-item
      onClick={onClick}
      className={cn(
        "relative flex h-[30px] items-center gap-2.5 rounded-control px-2 text-fg-subtle no-underline outline-none focus-visible:ring-2 focus-visible:ring-ring",
        current ? "text-foreground" : "hover:bg-selected",
        entry.disabled && "text-muted-foreground"
      )}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        className={cn("icon-light shrink-0", entry.disabled && "opacity-60")}
      >
        <path d={ICONS[entry.icon]} />
      </svg>
      <span className="flex-1 truncate text-body max-sm:sr-only">
        {entry.label}
      </span>
      {entry.attention && (
        <>
          <span className="sr-only">, {entry.attention.label}</span>
          <span
            aria-hidden
            className="figures rounded-full border border-border px-1.5 font-normal text-caption text-fg-subtle leading-4 max-sm:absolute max-sm:top-1 max-sm:right-1 max-sm:size-1.5 max-sm:border-0 max-sm:bg-fg-subtle max-sm:p-0 max-sm:text-[0px]"
          >
            {entry.attention.count}
          </span>
        </>
      )}
      {entry.busy ? (
        <>
          <span className="sr-only">, {entry.busy.label}</span>
          <span className="flex min-w-9 justify-end max-sm:absolute max-sm:top-1 max-sm:right-1 max-sm:min-w-0">
            <StatusDot state="live" />
          </span>
        </>
      ) : !entry.disabled && entry.value ? (
        <span className="figures min-w-9 text-right font-normal text-label text-muted-foreground max-sm:hidden">
          {entry.value}
        </span>
      ) : null}
    </a>
  );
}

/**
 * Dashboard navigation: entry groups, live values per module, the
 * active row, and a footer with the sampling state and version. Up/Down move
 * focus between entries, Home/End jump to the ends, Enter opens.
 */
export function Sidebar({
  groups,
  active,
  status,
  version,
  onNavigate,
  footerAction,
  footerNote,
  hostSwitcher,
}: SidebarProps) {
  const entriesRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const placed = useRef(false);
  const prevActive = useRef(active);
  const layout = groups
    .map((g) => `${g.entries.length}:${g.label ?? ""}`)
    .join(",");

  // The selection is one pill that slides to the current row (framer's
  // `layoutId` move) instead of a fill on each row. Measured only when the
  // route or group layout changes, or when the sidebar crosses the breakpoint.
  // Only route changes under a visible pill slide.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `active` and `layout` stand in for the rows' positions
  useLayoutEffect(() => {
    const pill = pillRef.current;
    if (!pill) return;

    const place = (slide: boolean) => {
      const row = entriesRef.current?.querySelector<HTMLElement>(
        "[data-sidebar-item][aria-current]"
      );
      if (!row) {
        pill.style.opacity = "0";
        placed.current = false;
        return;
      }
      if (!slide) pill.style.transition = "none";
      pill.style.opacity = "1";
      pill.style.transform = `translateY(${row.offsetTop}px)`;
      if (!slide) {
        // Commit the position before the transition comes back.
        pill.getBoundingClientRect();
        pill.style.transition = "";
      }
      placed.current = true;
    };

    place(placed.current && prevActive.current !== active);
    prevActive.current = active;

    // Matches Tailwind's max-sm variant, which hides the group headings.
    const compact = window.matchMedia("(width < 40rem)");
    const onBreakpointChange = () => place(false);
    compact.addEventListener("change", onBreakpointChange);
    return () => compact.removeEventListener("change", onBreakpointChange);
  }, [active, layout]);

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Existing cohesive logic; split when substantially changed (architecture refactor section 10).
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(e.key) || !entriesRef.current) return;
    const items = Array.from(
      entriesRef.current.querySelectorAll<HTMLAnchorElement>(
        "[data-sidebar-item]"
      )
    );
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLAnchorElement);
    let next = 0;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "ArrowDown")
      next = i < 0 ? 0 : Math.min(items.length - 1, i + 1);
    else next = i < 0 ? items.length - 1 : Math.max(0, i - 1);
    e.preventDefault();
    items[next]?.focus();
  };

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: arrow keys move focus between the links inside; the handler delegates to them
    <nav
      aria-label="Dashboard sections"
      onKeyDown={onKeyDown}
      className="flex h-full w-[220px] shrink-0 flex-col gap-0.5 border-border-subtle border-r bg-deep px-2.5 pt-2.5 pb-3 text-foreground max-sm:w-13 max-sm:px-2"
    >
      <SidebarBrand />
      {hostSwitcher && <div className="shrink-0">{hostSwitcher}</div>}
      <div
        ref={entriesRef}
        className="relative -mx-2.5 min-h-0 flex-1 scroll-py-0.5 overflow-y-auto px-2.5 py-0.5 max-sm:-mx-2 max-sm:px-2"
      >
        <div
          ref={pillRef}
          aria-hidden
          data-sidebar-pill
          className="pointer-events-none absolute inset-x-2.5 top-0 h-[30px] rounded-control bg-selected opacity-0 shadow-[inset_0_0_0_1px_var(--color-border)] transition-transform duration-(--motion-fast) ease-out max-sm:inset-x-2"
        />
        <div className="flex flex-col gap-0.5">
          {groups.map((g, gi) => (
            <SidebarGroup
              key={g.id}
              label={g.label}
              entries={g.entries}
              first={gi === 0}
              active={active}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      </div>
      {footerAction && <div className="shrink-0 pb-1.5">{footerAction}</div>}
      <div className="flex shrink-0 flex-col gap-1 border-border-subtle border-t px-2 pt-2.5 max-sm:sr-only">
        <div className="flex items-center gap-2">
          <SidebarStatusReadout status={status} />
          <span className="flex-1" />
          <span className="figures text-caption text-fg-faint">v{version}</span>
        </div>
        {footerNote}
      </div>
    </nav>
  );
}

function SidebarStatusReadout({ status }: { status: SidebarStatus }) {
  if (status.remoteStatus) {
    const isError = status.remoteStatus.tone === "error";
    return (
      <>
        {isError ? (
          <OctagonAlert
            aria-hidden
            className="icon-regular size-3 shrink-0 text-destructive"
          />
        ) : (
          <StatusDot state="stale" />
        )}
        <span
          className={cn(
            "min-w-0 truncate font-normal text-label",
            isError ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {status.remoteStatus.label}
        </span>
      </>
    );
  }
  if (status.paused) {
    return (
      <>
        <StatusDot state="paused" className="text-muted-foreground" />
        <span className="font-normal text-label text-muted-foreground">
          Paused
        </span>
      </>
    );
  }
  if (
    status.stale ||
    status.connection === "connecting" ||
    status.connection === "reconnecting"
  ) {
    const label =
      status.connection === "connecting"
        ? "Connecting…"
        : status.connection === "reconnecting"
          ? "Reconnecting…"
          : "Stale · no new data";
    return (
      <>
        <StatusDot state="stale" />
        <span className="min-w-0 truncate font-normal text-label text-muted-foreground">
          {label}
        </span>
      </>
    );
  }
  return (
    <>
      <StatusDot state="live" />
      <span className="min-w-0 truncate font-normal text-label text-muted-foreground">
        Sampling every{" "}
        <span className="figures">{intervalLabel(status.intervalMs)}</span>
        {status.onBattery && " · on battery"}
      </span>
    </>
  );
}

// The brand and navigation groups do not depend on live sample values. The
// page header's pinned bar is sized to line up with the brand row; keep
// `PageHeader` in step when its inset, strip or padding change.
const SidebarBrand = memo(function SidebarBrand() {
  return (
    <>
      <div aria-hidden data-tauri-drag-region className="h-[30px] shrink-0" />
      <div
        data-tauri-drag-region
        className="mb-2 flex shrink-0 items-center gap-2.5 border-border-subtle border-b px-2 pt-0.5 pb-2"
      >
        <StatGlassMark className="pointer-events-none size-5" />
        <span className="pointer-events-none font-wordmark text-title leading-none tracking-figure max-sm:sr-only">
          StatGlass
        </span>
      </div>
    </>
  );
});

const SidebarGroup = memo(function SidebarGroup({
  label,
  entries,
  first,
  active,
  onNavigate,
}: {
  label?: string | undefined;
  entries: readonly SidebarEntry[];
  first: boolean;
  active: string;
  onNavigate?: ((href: string) => void) | undefined;
}) {
  const headingId = useId();
  const spacing = first ? "pb-2" : "border-border-subtle border-t py-2";
  const list = (
    <ul
      aria-labelledby={label ? headingId : undefined}
      className={cn(
        "m-0 flex list-none flex-col gap-0.5 p-0",
        !label && spacing
      )}
    >
      {entries.map((entry) => (
        <li key={entry.id}>
          <SidebarItem
            entry={entry}
            current={entry.id === active}
            onNavigate={onNavigate}
          />
        </li>
      ))}
    </ul>
  );

  if (!label) return list;
  return (
    <div className={spacing}>
      <h2
        id={headingId}
        className="px-2 pb-1 font-normal text-label text-muted-foreground max-sm:sr-only"
      >
        {label}
      </h2>
      {list}
    </div>
  );
});
