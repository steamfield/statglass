import {
  type ComparisonMetric,
  pointCovered,
  seriesColor,
} from "@core/chart-math/series-lines";
import { resolutionLabel } from "@core/format";
import type {
  DockerContainer,
  DockerHistoryPoint,
} from "@core/generated/bindings";
import { Link, useLocation, useNavigate } from "react-router";
import {
  ChartTooltipHead,
  ChartTooltipNote,
  ChartTooltipRow,
  ChartTooltipRows,
  ChartTooltipShell,
  tooltipSide,
} from "~/components/charts/chart-tooltip";
import type { useBrushRange } from "~/stores/brush-store";
import { useSettingsStore } from "~/stores/settings-store";
import {
  containerReturnState,
  isContainerDetailClick,
} from "../_lib/navigation";
import type { ComparisonSeries } from "./comparison-chart";
export function ComparisonTooltip({
  rows,
  pinned,
  selection,
  cursor,
  from,
  to,
  duration,
  clock,
  link,
  displayName,
  statistics,
  format,
  metric,
}: {
  rows: readonly (ComparisonSeries & {
    point: DockerHistoryPoint | undefined;
    value: number | null;
  })[];
  pinned: boolean;
  selection: ReturnType<typeof useBrushRange>;
  cursor: number;
  from: number;
  to: number;
  duration: number;
  clock: (time: number) => string;
  link: (container: DockerContainer, point?: DockerHistoryPoint) => string;
  displayName: (container: DockerContainer) => string;
  statistics: (point: DockerHistoryPoint) => string;
  format: (value: number | null) => string;
  metric: ComparisonMetric;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const settings = useSettingsStore();
  const span = rows.find((r) => r.point)?.point?.duration_ms ?? duration;
  // Pinned, it stays put on the side away from the selection while hover
  // updates its values; unpinned, away from the hovered moment.
  const anchor = ((selection?.fromMs ?? cursor) - from) / (to - from);
  return (
    <ChartTooltipShell
      className={`top-2 ${pinned ? "pointer-events-auto" : ""} ${tooltipSide(anchor) === "left" ? "left-2" : "right-2"} max-w-full`}
    >
      <ChartTooltipHead
        title={`${clock(cursor)}–${clock(cursor + span)}`}
        detail={resolutionLabel(span)}
      />
      <ChartTooltipRows>
        {rows.map((row) => (
          <ChartTooltipRow
            key={row.container.id}
            color={seriesColor(row.slot)}
            label={
              pinned ? (
                <Link
                  className="underline"
                  to={link(row.container, row.point)}
                  onClick={(event) => {
                    if (!isContainerDetailClick(event)) return;
                    event.preventDefault();
                    void navigate(link(row.container, row.point), {
                      state: {
                        ...containerReturnState(location),
                        chartWindow:
                          settings.getState().snapshot?.settings.general
                            .chart_window,
                      },
                    });
                  }}
                >
                  {displayName(row.container)}
                </Link>
              ) : (
                displayName(row.container)
              )
            }
            value={`${
              row.value === null
                ? "no data"
                : row.point
                  ? statistics(row.point)
                  : format(row.value)
            }${
              row.point &&
              row.value !== null &&
              !pointCovered(row.point, metric)
                ? " partial"
                : ""
            }`}
          />
        ))}
      </ChartTooltipRows>
      <ChartTooltipNote>min / avg / max</ChartTooltipNote>
    </ChartTooltipShell>
  );
}
