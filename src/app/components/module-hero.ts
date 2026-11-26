import { formatPercent, formatWatts } from "@core/format";
import type { HeroChartSpec } from "@core/module-hero";
import type { ReadoutRow } from "~/components/charts/stream-hover";

export * from "@core/module-hero";

interface ReadoutSpec {
  label: string;
  /** Omitted: the chart's own y axis format (bytes in the user's units). */
  format?: (value: number) => string;
}

const pct1 = (v: number) => formatPercent(v, { decimals: 1 });

/** The hover row of each series a hero chart reads. */
const READOUT: Record<string, ReadoutSpec> = {
  "cpu.total": { label: "Total", format: pct1 },
  "cpu.system": { label: "System", format: pct1 },
  "gpu.util": { label: "Utilization", format: pct1 },
  "mem.pressure": { label: "Pressure", format: pct1 },
  "mem.used": { label: "Used" },
  "mem.cached": { label: "Cached files" },
  "battery.charge": { label: "Charge", format: (v) => formatPercent(v) },
  "power.system": { label: "System", format: (w) => formatWatts(w) },
};

/**
 * A hero chart's hover readout: one row per series it reads that has a
 * label here, in its key order, from the measured values rather than the
 * drawn lines, so a stacked line reads its own figure. Each row's swatch is
 * its line's ramp step.
 */
export function heroReadout(
  spec: HeroChartSpec,
  values: Record<string, (number | null)[]>
): ReadoutRow[] {
  const axis = spec.yAxis;
  const axisFormat = axis === "percent" ? pct1 : axis.format;
  const steps = new Map(spec.lines(values).map((l) => [l.key, l.step]));
  return spec.keys.flatMap((key) => {
    const row = READOUT[key];
    return row
      ? [
          {
            key,
            label: row.label,
            step: steps.get(key) ?? 1,
            values: values[key] ?? [],
            format: row.format ?? axisFormat,
          },
        ]
      : [];
  });
}
