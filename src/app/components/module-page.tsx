import type { ReactNode } from "react";
import { PageHeader } from "~/components/page-header";
import { WindowControl } from "~/components/window-control";
import {
  ChartRangeNotice,
  ChartRangeProvider,
  useModuleRange,
} from "~/stores/chart-range";

/**
 * The frame every module page with a chart window shares: the range scope,
 * the header with the window control, the recorded-history notice, and the
 * cards. The cards wait for the chart window (D-091), so they appear
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
        <ChartRangeNotice />
        {beforeBody}
        <ModulePageBody>{children}</ModulePageBody>
        {afterBody}
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
