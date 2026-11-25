import { cssPercent } from "@core/format";
import {
  STREAM_VIEWBOX_W,
  type StreamAreaData,
  streamAreaModel,
} from "@core/widget-models/stream-area";
import type { ColorRef } from "@core/widget-models/tokens";
import {
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useReveal } from "~/lib/motion/reveal";
import { cn } from "~/lib/utils";
import { PlacedChartAnnotations } from "./chart-annotation";
import { ChartFrame, ChartGrid, ChartSelectionVeil } from "./chart-frame";
import { ChartLoading } from "./chart-loading";
import { PlacedGapBands } from "./gap-band";
import { GapEdgeDot } from "./gap-edge-dot";
import { accentVars, rampColor } from "./lib/accent";
import styles from "./lib/scroll-layer.module.css";
import { useTickScroll } from "./lib/use-tick-scroll";

export { DEFAULT_LINE_WEIGHT } from "@core/widget-models/stream-area";

/**
 * Contract for the live area/line chart (design-system.md inventory): the
 * shared data contract plus the desktop's own overlay and labelling.
 */
export interface StreamAreaProps extends StreamAreaData {
  ariaLabelledBy?: string;
  /** Drawn over the plot area, sized to it (a brush layer). */
  overlay?: ReactNode;
}

/**
 * Live area chart. Each series is split at `null` into
 * runs; nothing bridges a gap, and a hollow dot marks each edge that borders
 * one. A one-point run draws no line (a round cap would make it a stray
 * dot); its edge dot still marks it. New samples slide in with a
 * `translateX` on the plot group.
 */
export function StreamArea(data: StreamAreaProps) {
  const {
    tEndMs,
    intervalMs,
    yMax,
    accent,
    ariaLabel,
    ariaLabelledBy,
    gridlines = [],
    yTicks,
    gutter,
    xTicks,
    highlight,
    overlay,
    loading,
  } = data;
  const reveal = useReveal<HTMLDivElement>(loading);
  const uid = useId();
  const [svgRef, widthPx] = useWidth<SVGSVGElement>();
  const {
    height,
    slots,
    series,
    gaps,
    annotations,
    ceilingLabel,
    windowLabel,
    dashOffset,
  } = streamAreaModel(data, { widthPx });
  const scrollRef = useTickScroll<HTMLDivElement>(
    tEndMs,
    intervalMs,
    cssPercent(1 / (slots - 1))
  );

  return (
    <ChartFrame
      height={height}
      ceiling={yMax}
      yTicks={yTicks}
      xTicks={xTicks}
      gutter={gutter}
      style={accentVars(accent)}
    >
      <div ref={reveal} className="relative overflow-hidden">
        <svg
          aria-hidden
          viewBox={`0 0 ${STREAM_VIEWBOX_W} ${height}`}
          preserveAspectRatio="none"
          width="100%"
          height={height}
          className="pointer-events-none absolute inset-0"
        >
          <ChartGrid values={gridlines} ceiling={yMax} height={height} />
        </svg>
        <div ref={scrollRef} className={cn("relative", styles.layer)}>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${STREAM_VIEWBOX_W} ${height}`}
            preserveAspectRatio="none"
            width="100%"
            height={height}
            role="img"
            aria-busy={loading || undefined}
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy}
            data-reveal
            className="block origin-bottom overflow-hidden"
          >
            <StreamSeries uid={uid} series={series} dashOffset={dashOffset} />
          </svg>
        </div>
        {loading && <ChartLoading className="inset-x-0 bottom-0" />}
      </div>
      <PlacedGapBands bands={gaps} />
      <ChartSelectionVeil highlight={highlight} />
      {series.flatMap(({ key, edges, stroke }) => {
        if (edges.length === 0) return [];
        const color = streamColor(stroke);
        return edges.map(({ xFrac, y }) => (
          <GapEdgeDot
            key={`${key}-${xFrac}`}
            left={`${xFrac * 100}%`}
            top={y}
            color={color}
          />
        ));
      })}
      <PlacedChartAnnotations annotations={annotations} widthPx={widthPx} />
      {ceilingLabel && (
        <span
          aria-hidden
          className="figures absolute -top-0.5 left-0 text-fg-faint text-micro"
        >
          {ceilingLabel}
        </span>
      )}
      {windowLabel && (
        <span
          aria-hidden
          className="figures absolute right-0 -bottom-3.5 text-fg-faint text-micro"
        >
          {windowLabel}
        </span>
      )}
      {overlay}
    </ChartFrame>
  );
}

const STROKES = {
  1: rampColor(1, "var(--a-ink)"),
  2: rampColor(2, "var(--a-ink)"),
  3: rampColor(3, "var(--a-ink)"),
  4: rampColor(4, "var(--a-ink)"),
};
const FILLS = {
  1: rampColor(1),
  2: rampColor(2),
  3: rampColor(3),
  4: rampColor(4),
};

function streamColor(color: Extract<ColorRef, { kind: "accent" }>) {
  return (color.ink ? STROKES : FILLS)[color.step];
}

function StreamSeries({
  uid,
  series,
  dashOffset,
}: Pick<ReturnType<typeof streamAreaModel>, "series" | "dashOffset"> & {
  uid: string;
}) {
  return (
    <>
      <defs>
        {series
          .filter((s) => s.filled)
          .map(({ key, fill }) => {
            const stopColor = streamColor(fill);
            return (
              <linearGradient
                key={key}
                id={`${uid}-${key}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0" style={{ stopColor, stopOpacity: 0.4 }} />
                <stop offset="1" style={{ stopColor, stopOpacity: 0 }} />
              </linearGradient>
            );
          })}
      </defs>
      <g>
        {series.map(
          ({
            key,
            opacity,
            filled,
            linePath,
            areaPath,
            stroke,
            weight,
            dash,
          }) => (
            <g key={key} data-series={key} opacity={opacity}>
              {filled && (
                <path data-area d={areaPath} fill={`url(#${uid}-${key})`} />
              )}
              <path
                data-line
                d={linePath}
                fill="none"
                style={{ stroke: streamColor(stroke) }}
                strokeWidth={weight}
                strokeDasharray={dash?.join(" ")}
                strokeDashoffset={dash ? dashOffset.toFixed(2) : undefined}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          )
        )}
      </g>
    </>
  );
}

/** The element's rendered width in px, 0 until measured. */
function useWidth<T extends Element>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}
