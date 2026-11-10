import { clamp01 } from "@core/chart-math";
import { cssPercent, MISSING } from "@core/format";
import { floorTo } from "@core/time-grid";
import { useRef } from "react";
import type { GapSpan } from "~/widgets/gap-band";
import { GapEdgeDot } from "~/widgets/gap-edge-dot";
import { Swatch } from "~/widgets/legend";
import { accentVars } from "~/widgets/lib/accent";
import { StreamArea } from "~/widgets/stream-area";
import { WindowTicks } from "~/widgets/window-ticks";

const PLOT_HEIGHT = 48;

export function HostMetricLane({
  label,
  value,
  values,
  endMs,
  intervalMs,
  yMax,
  gaps,
}: {
  label: "CPU" | "Memory";
  value: string;
  values: (number | null)[];
  endMs: number;
  intervalMs: number;
  yMax: number;
  gaps: readonly GapSpan[];
}) {
  const accent = label === "CPU" ? "cpu" : "mem";
  // Each card has its own host clock; do not subscribe to the selected host for labels.
  const bucket = floorTo(Date.now(), 10000);
  const reading = useRef({ bucket, value });
  if (
    reading.current.bucket !== bucket ||
    reading.current.value === MISSING ||
    value === MISSING
  )
    reading.current = { bucket, value };
  const ariaLabel = `${label}, last 10 minutes, ${reading.current.value === MISSING ? "no live reading" : `now ${reading.current.value}`}.`;
  return (
    <div className="flex min-w-0 flex-col gap-1.5" style={accentVars(accent)}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-1.5 font-normal text-label text-muted-foreground">
          <Swatch step={1} size={8} />
          {label}
        </span>
        <span className="figures-display text-figure">{value}</span>
      </div>
      <StreamArea
        series={[{ key: label, values, step: 1 }]}
        tEndMs={endMs}
        intervalMs={intervalMs}
        yMax={yMax}
        accent={accent}
        height={PLOT_HEIGHT}
        gridlines={[yMax / 2]}
        gaps={gaps}
        ariaLabel={ariaLabel}
        overlay={<BoundaryDots values={values} yMax={yMax} />}
      />
      <WindowTicks ticks={["-10m", "-5m", "now"]} />
    </div>
  );
}

/** StreamArea marks internal gaps and singleton runs; its overlay supplies outer edges. */
function BoundaryDots({
  values,
  yMax,
}: {
  values: (number | null)[];
  yMax: number;
}) {
  const first = values.findIndex((value) => value !== null);
  let last = values.length - 1;
  while (last >= 0 && values[last] == null) last--;
  const indices: number[] = [];
  if (first > 0 && values[first + 1] != null) indices.push(first);
  if (last >= 0 && last < values.length - 1 && values[last - 1] != null)
    indices.push(last);
  return indices.map((index) => {
    const value = values[index];
    if (value == null) return null;
    const top =
      1 + (1 - clamp01(value / (yMax > 0 ? yMax : 1))) * (PLOT_HEIGHT - 2);
    return (
      <GapEdgeDot
        key={index}
        left={cssPercent(index / (values.length - 1))}
        top={top}
        color="var(--a-ink)"
      />
    );
  });
}
