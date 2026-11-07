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
}: {
  title: string;
  subtitle?: ReactNode;
  /** The page's cards for the chart window, once settings have loaded. */
  children: (windowMs: number) => ReactNode;
}) {
  return (
    <ChartRangeProvider>
      <div className="flex flex-col gap-4">
        <PageHeader
          title={title}
          subtitle={subtitle}
          actions={<WindowControl />}
        />
        <ChartRangeNotice />
        <ModulePageBody>{children}</ModulePageBody>
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
