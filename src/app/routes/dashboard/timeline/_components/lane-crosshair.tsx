import { formatClockSeconds } from "@core/format";
import type { ProcessesAt } from "@core/generated/bindings";
import { gapExplanation } from "@core/history-state";
import { tooltipBeside } from "~/components/charts/chart-tooltip";
import { CrosshairLine } from "~/components/charts/crosshair-line";
import type { LaneData } from "../_hooks/use-timeline-data";
import type { LaneUnits } from "../_lib/format";
import type { Band } from "../_lib/gaps";
import type { buildLaneModel } from "../_lib/lane-model";
import { LANE_GAP, LANE_HEIGHT } from "../_lib/lanes";
import { dayLabel, fractionAt } from "../_lib/time";
import { CROSSHAIR_TOOLTIP_WIDTH, CrosshairTooltip } from "./crosshair-tooltip";
import { laneTooltipRows, laneValue } from "./lane-tooltip-rows";

export function LaneCrosshair({
  lanes,
  bands,
  models,
  cursor,
  width,
  fromMs,
  toMs,
  bucketMs,
  units,
  resolution,
  processes,
}: {
  lanes: LaneData[];
  bands: Band[];
  models: ReturnType<typeof buildLaneModel>[];
  cursor: number | null;
  width: number;
  fromMs: number;
  toMs: number;
  bucketMs: number;
  units: LaneUnits;
  resolution: string;
  processes: ProcessesAt | null | undefined;
}) {
  if (cursor === null || width <= 0) return null;
  const frac = fractionAt(cursor + bucketMs / 2, fromMs, toMs);
  const x = frac * width;
  const gapHere = bands.find(
    (b) => b.module === null && cursor >= b.fromMs && cursor < b.toMs
  );
  const value = (lane: LaneData | undefined, metric: string) =>
    laneValue(lane, metric, cursor, bucketMs);
  const rows = laneTooltipRows(lanes, cursor, bucketMs, units);
  const dots = models.flatMap((m, i) =>
    m.series.flatMap((s) => {
      const v = value(lanes[i], s.metric);
      return v === null
        ? []
        : [
            {
              key: `${m.def.id}-${s.metric}`,
              top:
                i * (LANE_HEIGHT + LANE_GAP) +
                m.yFraction(s.metric, v) * LANE_HEIGHT,
              color: `var(--color-${s.accent}-ink)`,
            },
          ];
    })
  );
  return (
    <>
      <CrosshairLine left={x} top={-6} height="calc(100% + 6px)" dots={dots} />
      <CrosshairTooltip
        title={`${dayLabel(cursor)} · ${formatClockSeconds(cursor)}`}
        resolution={resolution}
        rows={rows}
        processes={gapHere ? null : processes}
        note={gapHere ? (gapExplanation(gapHere) ?? undefined) : undefined}
        style={tooltipBeside(frac, CROSSHAIR_TOOLTIP_WIDTH)}
      />
    </>
  );
}
