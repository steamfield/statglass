import { memo, useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { cssVar, useThemeVersion, withAlpha } from "~/components/charts/theme";
import { gapEdgePoints } from "~/widgets/gap-edge-dot";
import type { PlotSeries } from "../_lib/lane-model";

export interface LanePlotProps {
  x: number[];
  series: PlotSeries[];
  domain: [number, number];
  /** Where area fills end: the domain floor, or 0 for a mirrored plot. */
  baseline: number;
  fromMs: number;
  toMs: number;
  height: number;
  ariaLabel: string;
}

const AREA_ALPHA = { area: 0.38, faint: 0.14, line: 0 } as const;

/** Each bucket's bar fills 70% of its slot, starting at the bucket's start. */
const BARS = uPlot.paths.bars?.({
  size: [0.7, Number.POSITIVE_INFINITY],
  align: 1,
});

/**
 * A `bars` series in the Network page's colours: upload in ramp step 2,
 * download in step 1, read from the theme so both pages match.
 */
function barSeries(el: HTMLElement, fill: string, up: boolean): uPlot.Series {
  const ramp = parseFloat(cssVar(el, up ? "--ramp-2" : "--ramp-1"));
  return {
    stroke: "transparent",
    width: 0,
    fillTo: 0,
    fill: withAlpha(fill, Number.isFinite(ramp) ? ramp / 100 : 1),
    ...(BARS && { paths: BARS }),
    points: { show: false },
  };
}

/** The envelope's min and max columns: data for the band, never drawn. */
const HIDDEN: uPlot.Series = { stroke: "transparent", points: { show: false } };

/**
 * A series' average line in the accent ink, with its area fill (a gradient
 * from the baseline, flipped for a downward series) unless it is a bare line.
 */
function avgSeries(
  look: keyof typeof AREA_ALPHA,
  down: boolean,
  fill: string,
  ink: string,
  baseline: number,
  { points }: { points: uPlot.Series["points"] }
): uPlot.Series {
  return {
    stroke: look === "faint" ? withAlpha(ink, 0.55) : ink,
    width: 1.5,
    fillTo: baseline,
    ...(look !== "line" && {
      fill: (u: uPlot) => {
        const top = u.bbox.top;
        const bottom = top + u.bbox.height;
        const zero = u.valToPos(baseline, "y", true);
        const a = AREA_ALPHA[look];
        const g = u.ctx.createLinearGradient(
          0,
          down ? zero : top,
          0,
          down ? bottom : zero
        );
        g.addColorStop(0, withAlpha(fill, down ? 0.08 : a));
        g.addColorStop(1, withAlpha(fill, down ? a : 0));
        return g;
      },
    }),
    ...(points && { points }),
  };
}

function toData(x: number[], series: PlotSeries[]): uPlot.AlignedData {
  return [
    x,
    ...series.flatMap((s) => [s.cols.max, s.cols.min, s.cols.avg]),
  ] as uPlot.AlignedData;
}

/**
 * One Timeline lane on uPlot (canvas): per series an avg line in the accent
 * ink, an optional area fill, the min/max envelope, and hollow dots where the
 * line meets a gap; or, for a `bars` series, one bar per bucket. No axes
 * or cursor: the lane stack draws one shared axis, the gap bands and the
 * crosshair over every lane.
 *
 * The plot is built once per shape (series count, domain, theme) and fed new
 * data with `setData` when a bucket closes.
 */
export const LanePlot = memo(function LanePlot({
  x,
  series,
  domain,
  baseline,
  fromMs,
  toMs,
  height,
  ariaLabel,
}: LanePlotProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const theme = useThemeVersion();
  const [lo, hi] = domain;
  const shape = series
    .map((s) => `${s.accent}:${s.look}:${s.envelope}:${s.direction ?? "up"}`)
    .join("|");
  const edgesRef = useRef(series.map((s) => s.edges));
  edgesRef.current = series.map((s) => s.edges);
  // Read by the x range function: a static range would pin the first window.
  const xRangeRef = useRef<[number, number]>([fromMs, toMs]);
  xRangeRef.current = [fromMs, toMs];

  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuilt per shape and theme; data flows through the effect below
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    void theme;
    const background = cssVar(el, "--color-card");
    const opts: uPlot.Series[] = [{}];
    const bands: uPlot.Band[] = [];
    series.forEach((s, k) => {
      const fill = cssVar(el, `--color-${s.accent}`);
      const ink = cssVar(el, `--color-${s.accent}-ink`) || fill;
      const base = 1 + k * 3;
      opts.push(
        HIDDEN,
        HIDDEN,
        s.look === "bars"
          ? barSeries(el, fill, s.direction !== "down")
          : avgSeries(s.look, s.direction === "down", fill, ink, baseline, {
              points: gapEdgePoints(
                ink,
                background,
                () => edgesRef.current[k] ?? []
              ),
            })
      );
      if (s.envelope) {
        bands.push({
          series: [base, base + 1],
          fill: withAlpha(fill, s.look === "faint" ? 0.1 : 0.2),
        });
      }
    });
    const plot = new uPlot(
      {
        width: Math.max(1, el.clientWidth),
        height,
        padding: [0, 0, 0, 0],
        legend: { show: false },
        cursor: { show: false },
        scales: {
          x: { time: false, range: () => xRangeRef.current },
          y: { range: [lo, hi] },
        },
        axes: [{ show: false }, { show: false }],
        series: opts,
        bands,
      },
      toData(x, series),
      el
    );
    plotRef.current = plot;
    const resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(([entry]) => {
            const w = entry?.contentRect.width;
            if (w) plot.setSize({ width: w, height });
          });
    resize?.observe(el);
    return () => {
      resize?.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
  }, [shape, lo, hi, baseline, height, theme]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new window (fromMs, toMs) must re-range x even when the data is unchanged
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    // Re-ranging runs the x range function above for the new window.
    plot.setData(toData(x, series), true);
  }, [x, series, fromMs, toMs]);

  // Gridlines at the quarters and an axis line at the bottom; the
  // mirrored network lane has only its centre baseline.
  const mirrored = lo < 0;
  return (
    <div
      role="img"
      aria-label={ariaLabel}
      data-lane-plot
      className="relative"
      style={{ height }}
    >
      {mirrored ? (
        <div aria-hidden className="absolute inset-x-0 top-1/2 h-px bg-axis" />
      ) : (
        <>
          {[25, 50, 75].map((p) => (
            <div
              key={p}
              aria-hidden
              className="absolute inset-x-0 h-px bg-grid"
              style={{ top: `${p}%` }}
            />
          ))}
          <div
            aria-hidden
            className="absolute inset-x-0 bottom-0 h-px bg-axis"
          />
        </>
      )}
      <div ref={hostRef} className="absolute inset-0" />
    </div>
  );
});
