import { createContext, type ReactNode, useContext } from "react";
import { cn } from "~/lib/utils";

export interface DashboardShellState {
  /** Banners rendered immediately below the sticky PageHeader (never dimmed). */
  readonly banners: ReactNode;
  /**
   * Focal replacement for the page body when a disconnected remote host has no
   * saved history (or on live-only pages like Processes). Keeps PageHeader and
   * sidebar navigation intact.
   */
  readonly focalNotice: ReactNode;
  /**
   * Dim the live metric body to 50% when a connected/local stream has gone
   * stale; never dims PageHeader, banners, or readable mirrored history.
   */
  readonly dimBody: boolean;
}

const DEFAULT_SHELL: DashboardShellState = {
  banners: null,
  focalNotice: null,
  dimBody: false,
};

export const DashboardShellContext =
  createContext<DashboardShellState>(DEFAULT_SHELL);

export function useDashboardShell(): DashboardShellState {
  return useContext(DashboardShellContext);
}

/** Non-dimmed dashboard banners rendered directly beneath the sticky PageHeader. */
export function DashboardBanners() {
  const { banners } = useDashboardShell();
  if (!banners) return null;
  return (
    <div
      data-dashboard-banners
      className="flex w-full flex-col gap-3 empty:hidden"
    >
      {banners}
    </div>
  );
}

/**
 * Wraps the data region below `<PageHeader>` and `<DashboardBanners />`.
 * Renders `focalNotice` instead of an empty skeleton when a disconnected host
 * has nothing to show here, or dims only live-stale bodies.
 */
export function DashboardBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const { focalNotice, dimBody } = useDashboardShell();
  if (focalNotice) {
    return <div className="w-full">{focalNotice}</div>;
  }
  return (
    <div
      data-stagger
      className={cn(
        "flex flex-col gap-4 transition-opacity duration-(--motion-crossfade)",
        dimBody && "opacity-50",
        className
      )}
    >
      {children}
    </div>
  );
}
