import { clamp01 } from "@core/chart-math";
import { cssPercent, formatPercent, MISSING } from "@core/format";
import { floorTo } from "@core/time-grid";
import { memo, useEffect, useId, useMemo, useState } from "react";
import { useHost } from "~/stores/host-store";
import { held } from "~/stores/live-selectors";
import type { GapSpan } from "~/widgets/gap-band";
import { GapEdgeDot } from "~/widgets/gap-edge-dot";
import { Swatch } from "~/widgets/legend";
import { accentVars } from "~/widgets/lib/accent";
import { StreamArea } from "~/widgets/stream-area";
import { WindowTicks } from "~/widgets/window-ticks";

const PLOT_HEIGHT = 48;

export const HostMetricLane = memo(function HostMetricLane({
  local = false,
  label,
  value,
  values,
  endMs,
  intervalMs,
  yMax,
  gaps,
}: {
  local?: boolean;
  label: "CPU" | "Memory";
  value: string;
  values: (number | null)[];
  endMs: number;
  intervalMs: number;
  yMax: number;
  gaps: readonly GapSpan[];
}) {
  const readingId = useId();
  const accent = label === "CPU" ? "cpu" : "mem";
  const overlay = useMemo(
    () => <BoundaryDots values={values} yMax={yMax} />,
    [values, yMax]
  );
  return (
    <div className="flex min-w-0 flex-col gap-1.5" style={accentVars(accent)}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-1.5 font-normal text-label text-muted-foreground">
          <Swatch step={1} size={8} />
          {label}
        </span>
        {local ? (
          label === "CPU" ? (
            <LocalCpuFigure id={readingId} />
          ) : (
            <LocalMemoryFigure id={readingId} value={value} />
          )
        ) : (
          <MetricFigure id={readingId} label={label} value={value} />
        )}
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
        ariaLabelledBy={readingId}
        overlay={overlay}
      />
      <WindowTicks ticks={["-10m", "-5m", "now"]} />
    </div>
  );
});

function LocalCpuFigure({ id }: { id: string }) {
  const cpu = useHost((state) =>
    state.stale ? null : held(state, "cpu.total")
  );
  return <MetricFigure id={id} label="CPU" value={formatPercent(cpu)} />;
}

function LocalMemoryFigure({ id, value }: { id: string; value: string }) {
  // Memory uses Rust's percentage; bytes are not a substitute for that fact.
  const stale = useHost((state) => state.stale);
  return (
    <MetricFigure id={id} label="Memory" value={stale ? MISSING : value} />
  );
}

/** Keep the accessible current figure steady within each ten-second bucket. */
function MetricFigure({
  id,
  label,
  value,
}: {
  id: string;
  label: string;
  value: string;
}) {
  const [reading, setReading] = useState<{
    bucket: number | null;
    value: string;
  }>({ bucket: null, value });
  useEffect(() => {
    const now = Date.now();
    const bucket = floorTo(now, 10000);
    if (reading.bucket !== bucket) {
      setReading({ bucket, value });
      return;
    }
    if (reading.value === value) return;
    // Flush the last pending value even when an outage stops further ticks.
    const timer = setTimeout(
      () => setReading({ bucket: floorTo(Date.now(), 10000), value }),
      bucket + 10000 - now
    );
    return () => clearTimeout(timer);
  }, [value, reading]);
  return (
    <>
      <span className="figures-display text-figure">{value}</span>
      <span
        id={id}
        hidden
      >{`${label}, last 10 minutes, ${reading.value === MISSING ? "no live reading" : `now ${reading.value}`}.`}</span>
    </>
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
