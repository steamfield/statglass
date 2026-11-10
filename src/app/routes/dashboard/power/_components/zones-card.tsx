import {
  formatTemperature,
  resolutionWords,
  type TemperatureUnits,
} from "@core/format";
import { spanWords } from "@core/live-window";
import { parseLabels } from "@core/series-key";
import { heatmapBucketMs } from "@core/series-stats";
import { useDeferredValue } from "react";
import { ChartHistoryStatus } from "~/components/chart-history-status";
import { SectionCard } from "~/components/section-card";
import { useChartLabel } from "~/hooks/use-chart-label";
import { useGapBands } from "~/hooks/use-gap-bands";
import { useGridInterval } from "~/hooks/use-grid-interval";
import { useModuleBuckets } from "~/hooks/use-module-buckets";
import { useModuleEnd } from "~/hooks/use-module-end";
import { useHeld, useLayout } from "~/hooks/use-ring";
import { useUnits } from "~/hooks/use-units";
import { HeatMatrix, HeatScaleLegend } from "~/widgets/heat-matrix";
import { sensorLabel, zoneName } from "../_lib/sensors";

/** Fixed domain for temperature (design-system.md "Y scale"), °C. */
const TEMP_SCALE = { min: 20, max: 110 };

/** A `thermal.zone{sensor}` or `thermal.sensor{name}` key's sensor name. */
function labelValue(key: string): string {
  const labels = parseLabels(key);
  return labels.sensor ?? labels.name ?? "";
}

/**
 * SoC thermal zones over the chart window (D-091), the same bucketed matrix
 * as per-core load. Rows keep layout order ("Zone 01" first) so they never
 * jump; the hottest zones read from the right column. Temperatures are
 * never colored by value: intensity on the single temperature hue.
 */
export function ZonesCard({ windowMs: windowProp }: { windowMs: number }) {
  // Deferred for the same reason as CoreLoadCard: a window change remounts
  // every cell, which React can then split across frames.
  const windowMs = useDeferredValue(windowProp);
  const end = useModuleEnd();
  const desiredBucketMs = heatmapBucketMs(windowMs, useGridInterval());
  const units = useUnits().temperature;
  const layout = useLayout();
  const zoneList = layout?.byMetric.get("thermal.zone") ?? [];
  const sensorList = layout?.byMetric.get("thermal.sensor") ?? [];
  // Without SoC zones (a Linux agent, D-116) the named sensors are the rows.
  const zones = zoneList.length > 0 || sensorList.length === 0;
  const zoneKeys = zones ? zoneList : sensorList;
  const sensorKeys = zones ? sensorList : [];
  const now = useHeld([...zoneKeys, ...sensorKeys]);
  const gaps = useGapBands("sensors");
  const { values, endMs, bucketMs, loading, ringLoading, error } =
    useModuleBuckets(
      zoneKeys,
      desiredBucketMs,
      Math.ceil(windowMs / desiredBucketMs),
      windowMs
    );
  const title = zones ? "SoC thermal zones" : "Temperature sensors";
  const span = spanWords(windowMs, end);
  const temp = (c: number) => formatTemperature(c, { units });
  const compact = (c: number | null) =>
    formatTemperature(c, { units, compact: true });
  const rowLabel = (k: string, i: number) =>
    zones ? zoneName(i) : sensorLabel(labelValue(k));
  // The matrix is one image, so the row tooltips' sensor names and the
  // right column's readings go here too.
  const zoneReadings = zoneKeys
    .map((k, i) =>
      zones
        ? `${zoneName(i)} (${labelValue(k)}) ${compact(now[k] ?? null)}`
        : `${rowLabel(k, i)} ${compact(now[k] ?? null)}`
    )
    .join(", ");
  const ariaLabel = useChartLabel({
    subject: title,
    span,
    now: `each column a ${resolutionWords(bucketMs)}. ${zoneReadings}`,
  });

  return (
    <SectionCard
      accent="power"
      origin="bl"
      title={`${title}, ${span}`}
      aside={
        <HeatScaleLegend
          accent="temp"
          minLabel={temp(TEMP_SCALE.min)}
          maxLabel={temp(TEMP_SCALE.max)}
        />
      }
      headerAlign="center"
      compactHeader
      className="gap-3"
    >
      <p className="-mt-1 font-normal text-muted-foreground text-small">
        {zones
          ? "Apple doesn't document which zone sits over which core, so zones keep their sensor names."
          : "As the kernel names them."}
      </p>
      <ChartHistoryStatus quiet loading={loading} error={error} />
      <HeatMatrix
        loading={loading === true || ringLoading}
        live={end === null}
        gaps={gaps}
        rows={zoneKeys.map((k, i) => ({
          id: k,
          label: rowLabel(k, i),
          title: labelValue(k),
          now: now[k] ?? null,
          buckets: values[k] ?? [],
        }))}
        scale={TEMP_SCALE}
        formatNow={compact}
        labelWidth={zones ? 44 : 148}
        bucketMs={bucketMs}
        windowMs={windowMs}
        endMs={endMs}
        accent="temp"
        ariaLabel={ariaLabel}
      />
      <OtherSensors
        units={units}
        sensors={sensorKeys.map((k) => ({
          label: sensorLabel(labelValue(k)),
          value: now[k] ?? null,
        }))}
      />
    </SectionCard>
  );
}

/** Battery, SSD and Wi‑Fi temperatures under the zones. */
function OtherSensors({
  sensors,
  units,
}: {
  sensors: readonly { label: string; value: number | null }[];
  units: TemperatureUnits;
}) {
  if (sensors.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-5 border-border-subtle border-t pt-2.5">
      {sensors.map((x) => (
        <span key={x.label} className="font-normal text-fg-subtle text-small">
          {x.label}{" "}
          <span className="figures text-foreground">
            {formatTemperature(x.value, { units })}
          </span>
        </span>
      ))}
    </div>
  );
}
