import type { ReactNode } from "react";
import { PageHeader } from "~/components/page-header";
import { WindowControl } from "~/components/window-control";
import { DashboardBanners, DashboardBody } from "~/lib/dashboard-shell";
import {
  ChartRangeNotice,
  ChartRangeProvider,
  useModuleRange,
} from "~/stores/chart-range";

/**
 * The frame every module page with a chart window shares: the sticky header
 * pinned to `top: 0`, any dashboard banners right beneath it, and the body
 * (swapped for a focal connection state when an offline remote host has no
 * saved history). The cards wait for the chart window (D-091), so they appear
 * together instead of drawing a span they would redo.
 */
export function ModulePage({
  title,
  subtitle,
  children,
  actions,
  beforeBody,
  afterBody,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Renders below the range notice and outside the settings wait. */
  beforeBody?: ReactNode;
  /** Trailing content in the gap column, also outside the settings wait. */
  afterBody?: ReactNode;
  /** The page's cards for the chart window, once settings have loaded. */
  children: (windowMs: number) => ReactNode;
}) {
  return (
    <ChartRangeProvider>
      <div className="flex flex-col gap-4">
        <PageHeader
          title={title}
          subtitle={subtitle}
          actions={
            actions ? (
              <div className="flex flex-wrap items-center gap-3">
                {actions}
                <WindowControl />
              </div>
            ) : (
              <WindowControl />
            )
          }
        />
        <DashboardBanners />
        <DashboardBody>
          <ChartRangeNotice />
          {beforeBody}
          <ModulePageBody>{children}</ModulePageBody>
          {afterBody}
        </DashboardBody>
      </div>
    </ChartRangeProvider>
  );
}

function ModulePageBody({
  children,
}: {
  children: (windowMs: number) => ReactNode;
}) {
  const range = useModuleRange();
  return range === null ? null : children(range.windowMs);
}
