import { cssPercent } from "@core/format";
import { PAUSE_EXPLANATION } from "@core/history-state";
import { DAY_MS } from "@core/time-grid";
import {
  type GapSpan,
  gapBandPosition,
  gapBandsModel,
  type PlacedGapBand,
} from "@core/widget-models/gap-band";
import { Pause } from "lucide-react";
import { cn } from "~/lib/utils";

export type { GapSpan };

export interface GapBandProps {
  fromMs: number;
  toMs: number;
  /** "Asleep 11:02–11:31 · not interpolated", "Paused", "StatGlass not running". */
  label: string;
  reason?: string | undefined;
  closedDurationMs?: number | null;
  showCaption?: boolean | undefined;
  /**
   * The chart's x range. When given, the band positions itself absolutely
   * inside a `relative` plot box; without it, it fills its parent.
   */
  rangeFromMs?: number;
  rangeToMs?: number;
  /**
   * Where the label sits: straddling the bottom edge, in the middle of the
   * band (Timeline lanes, where the edge is the next lane), or hidden.
   */
  labelPosition?: "bottom" | "center" | "none";
}

/**
 * Hatched band over a span with no data: 1 px stripes at
 * 7 px in `--color-grid`, dashed edges, and a label saying why. Lines stop at
 * its edges; nothing is drawn across it.
 */
export function GapBand({
  fromMs,
  toMs,
  label,
  rangeFromMs,
  rangeToMs,
  labelPosition,
  reason,
  showCaption = true,
}: GapBandProps) {
  const position =
    rangeFromMs !== undefined && rangeToMs !== undefined
      ? gapBandPosition({ fromMs, toMs }, rangeFromMs, rangeToMs)
      : undefined;
  return (
    <GapBandMark
      fromMs={fromMs}
      toMs={toMs}
      label={label}
      paused={reason === "paused"}
      showCaption={showCaption}
      labelPosition={labelPosition}
      position={position}
    />
  );
}

function GapBandMark({
  fromMs,
  toMs,
  label,
  paused,
  showCaption,
  labelPosition = "bottom",
  position,
}: Pick<
  PlacedGapBand,
  "fromMs" | "toMs" | "label" | "paused" | "showCaption"
> & {
  labelPosition?: GapBandProps["labelPosition"];
  position: Pick<PlacedGapBand, "leftFrac" | "widthFrac"> | undefined;
}) {
  const accessibleLabel = paused ? PAUSE_EXPLANATION : label;
  return (
    <div
      role="note"
      aria-label={accessibleLabel}
      data-gap-from={fromMs}
      data-gap-to={toMs}
      className={cn(
        "pointer-events-none flex justify-center border-border-strong border-x border-dashed bg-gap-hatch",
        labelPosition === "center" ? "items-center" : "items-end",
        position ? "absolute inset-y-0" : "relative h-full min-h-12 w-full"
      )}
      style={
        position
          ? {
              left: cssPercent(position.leftFrac, 2),
              width: cssPercent(position.widthFrac, 2),
            }
          : undefined
      }
    >
      {labelPosition !== "none" && showCaption && (
        <span
          title={accessibleLabel}
          className={cn(
            "inline-flex items-center gap-1 whitespace-nowrap text-fg-subtle text-label",
            labelPosition === "bottom" && "translate-y-1/2",
            !paused && "rounded-control border border-border bg-card px-2 py-1"
          )}
        >
          {paused && <Pause aria-hidden className="size-3" />}
          {label}
        </span>
      )}
    </div>
  );
}

/**
 * The gaps that overlap a chart's x range, as positioned bands. Render it
 * inside the chart's `relative` plot box; a band that runs past either edge
 * is clipped to it, and its label centres on the visible part. A chart
 * whose tick row sits close under the plot puts the label in the band's
 * middle (`labelPosition="center"`); ranges wider than a day drop it.
 */
export function GapBands({
  gaps,
  rangeFromMs,
  rangeToMs,
  labelPosition = "bottom",
}: {
  gaps: readonly GapSpan[];
  rangeFromMs: number;
  rangeToMs: number;
  labelPosition?: "bottom" | "center";
}) {
  return (
    <PlacedGapBands
      bands={gapBandsModel(gaps, rangeFromMs, rangeToMs)}
      labelPosition={rangeToMs - rangeFromMs > DAY_MS ? "none" : labelPosition}
    />
  );
}

/** Draws bands already placed by a chart model. */
export function PlacedGapBands({
  bands,
  labelPosition,
}: {
  bands: readonly PlacedGapBand[];
  labelPosition?: GapBandProps["labelPosition"];
}) {
  return bands.map(({ key, ...band }) => (
    <GapBandMark
      key={key}
      {...band}
      labelPosition={labelPosition}
      position={band}
    />
  ));
}
