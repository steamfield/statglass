import { formatPercent, formatWatts } from "@core/format";
import type { HeroChartSpec } from "@core/module-hero";
import type { ReadoutRow } from "~/components/charts/stream-hover";

export * from "@core/module-hero";

interface ReadoutSpec {
  label: string;
  step: ReadoutRow["step"];
  /** Omitted: the chart's own y axis format (bytes in the user's units). */
  format?: (value: number) => string;
}

const pct1 = (v: number) => formatPercent(v, { decimals: 1 });

/** The hover row of each series a hero chart reads. */
const READOUT: Record<string, ReadoutSpec> = {
  "cpu.total": { label: "Total", step: 1, format: pct1 },
  "cpu.system": { label: "System", step: 2, format: pct1 },
  "gpu.util": { label: "Utilization", step: 1, format: pct1 },
  "mem.pressure": { label: "Pressure", step: 1, format: pct1 },
  "mem.used": { label: "Used", step: 1 },
  "mem.cached": { label: "Cached files", step: 4 },
  "battery.charge": {
    label: "Charge",
    step: 1,
    format: (v) => formatPercent(v),
  },
  "power.system": { label: "System", step: 1, format: (w) => formatWatts(w) },
};

/**
 * A hero chart's hover readout: one row per series it reads, in its key
 * order, from the measured values rather than the drawn lines, so a stacked
 * line reads its own figure.
 */
export function heroReadout(
  spec: HeroChartSpec,
  values: Record<string, (number | null)[]>
): ReadoutRow[] {
  const axis = spec.yAxis;
  const axisFormat = axis === "percent" ? pct1 : axis.format;
  return spec.keys.flatMap((key) => {
    const row = READOUT[key];
    return row
      ? [
          {
            key,
            label: row.label,
            step: row.step,
            values: values[key] ?? [],
            format: row.format ?? axisFormat,
          },
        ]
      : [];
  });
}
