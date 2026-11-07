import {
  type buildSeriesRuns,
  seriesColor,
} from "@core/chart-math/series-lines";
import { seriesFocusStyle } from "~/hooks/use-series-focus";
import { GAP_EDGE_DOT } from "~/widgets/gap-edge-dot";
import type { ComparisonSeries } from "./comparison-chart";

/** `GapEdgeDot` in SVG: the ring's centre radius, so its outer edge is 7 px. */
const EDGE_R = (GAP_EDGE_DOT.size - GAP_EDGE_DOT.stroke) / 2;

export function ComparisonLines({
  plotSeries,
  active,
  onFocus,
  plotWidth,
}: {
  plotSeries: readonly (ComparisonSeries & {
    geometry: ReturnType<typeof buildSeriesRuns>;
  })[];
  active: string | null;
  onFocus: (id: string | null) => void;
  plotWidth: number;
}) {
  return (
    <>
      {" "}
      {plotSeries.map((s) => (
        <g
          key={s.container.id}
          opacity={seriesFocusStyle(active, s.container.id).opacity}
          onPointerEnter={() => onFocus(s.container.id)}
        >
          {/* Each band spans its own bucket; missing spans remain empty. */}
          <path
            d={s.geometry.bands
              .filter((band) => !band.partial)
              .map(
                (band) =>
                  `M${band.x},${band.maximumY + 1}h${band.width}V${band.minimumY + 1}h${-band.width}Z`
              )
              .join(" ")}
            fill={seriesColor(s.slot)}
            fillOpacity={0.2}
          />
          <path
            d={s.geometry.bands
              .filter((band) => band.partial)
              .map(
                (band) => `M${band.x},${band.maximumY + 1}V${band.minimumY + 1}`
              )
              .join(" ")}
            fill="none"
            stroke={seriesColor(s.slot)}
            strokeOpacity={0.2}
            vectorEffect="non-scaling-stroke"
          />
          {s.geometry.runs.map((run) => (
            <path
              key={run[0]?.time}
              d={run
                .map((p, index) => `${index ? "L" : "M"}${p.x},${p.y + 1}`)
                .join(" ")}
              fill="none"
              stroke={seriesColor(s.slot)}
              strokeWidth={seriesFocusStyle(active, s.container.id).weight}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {s.geometry.dots.map((dot) =>
            dot.partial ? (
              // A partial bucket's average: filled, beside its range marker
              // (design-system.md "Gaps" exception).
              <ellipse
                key={dot.time}
                data-partial-dot
                cx={dot.x}
                cy={dot.y + 1}
                rx={(3 * 1000) / plotWidth}
                ry={3}
                fill={seriesColor(s.slot)}
                vectorEffect="non-scaling-stroke"
              />
            ) : (
              // A covered one-bucket run: the hollow gap-edge dot.
              <ellipse
                key={dot.time}
                data-gap-edge
                cx={dot.x}
                cy={dot.y + 1}
                rx={(EDGE_R * 1000) / plotWidth}
                ry={EDGE_R}
                fill="var(--color-card)"
                stroke={seriesColor(s.slot)}
                strokeWidth={GAP_EDGE_DOT.stroke}
                vectorEffect="non-scaling-stroke"
              />
            )
          )}
        </g>
      ))}
    </>
  );
}
