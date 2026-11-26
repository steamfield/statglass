/** History and live readings for the host's temperature sensors. */
import { formatTemperature, type TemperatureUnits } from "@core/format";
import type { HostId } from "@core/generated/types";
import { historyGrid } from "@core/history-grid";
import { gapBands } from "@core/history-state";
import { currentLayout, held } from "@core/live-selectors";
import { labelOf, seriesKeyString } from "@core/series-key";
import { gapBandsModel } from "@core/widget-models/gap-band";
import { heatMatrixModel } from "@core/widget-models/heat-matrix";
import { memo, useMemo, useState } from "react";
import { useWindowDimensions } from "react-native";
import { shallow } from "zustand/shallow";
import {
  type HistoryRange,
  useHostHistory,
  useRefreshOnRangeChange,
} from "@/data/history";
import { useHostLive } from "@/data/live";
import { HistoryNotice } from "@/module/history-notice";
import { ModuleNotice } from "@/module/module-notice";
import { Card } from "@/ui/card";
import { Text } from "@/ui/text";
import {
  type HeatColumns,
  HeatMatrix,
  squareCellColumns,
} from "@/widgets/heat-matrix";
import { StatList } from "@/widgets/stat-list";

const TEMPERATURE_DOMAIN = [20, 110] as const;
/** Room for "Zone 10" and "221 °F" at the default text size. */
const ZONE_SIDES: HeatColumns = { label: 48, reading: 50 };
/** Sensor names are longer; they wrap inside this column. */
const SENSOR_SIDES: HeatColumns = { label: 96, reading: 50 };
// The card's p-3 on each side.
const CARD_PADDING = 24;

/** Render a heatmap and current readings for available temperature sensors. */
export const ThermalHistory = memo(function ThermalHistory({
  host,
  hostName,
  range,
  live,
  units,
}: {
  host: HostId;
  hostName: string | undefined;
  range: HistoryRange;
  live: boolean;
  units: TemperatureUnits;
}) {
  const layout = useHostLive(host, currentLayout);
  const { selection, rows, otherSensors, zones } = useMemo(() => {
    const series = layout?.series ?? [];
    const zones = layout?.byMetric.has("thermal.zone") ?? false;
    const sensors = series.filter((key) => key.metric === "thermal.sensor");
    const selection = zones
      ? series.filter((key) => key.metric === "thermal.zone")
      : sensors;
    return {
      selection,
      zones,
      rows: selection.map((key, index) => ({
        key: seriesKeyString(key),
        label: zones
          ? `Zone ${String(index + 1).padStart(2, "0")}`
          : (labelOf(key, "name") ?? seriesKeyString(key)),
        title: labelOf(key, zones ? "sensor" : "name") ?? seriesKeyString(key),
      })),
      otherSensors: zones ? sensors : [],
    };
  }, [layout]);
  const windowMs = range.toMs - range.fromMs;
  const sides = zones ? ZONE_SIDES : SENSOR_SIDES;
  const [width, setWidth] = useState(0);
  const { fontScale } = useWindowDimensions();
  const count =
    width > 0 ? squareCellColumns(width - CARD_PADDING, sides, fontScale) : 0;
  const columns = useMemo(() => ({ columns: count }), [count]);
  const history = useHostHistory(
    host,
    selection,
    range,
    rows.length && count > 0 ? columns : null
  );
  useRefreshOnRangeChange(windowMs, history);
  const data = history.data;
  const grid = useMemo(
    () =>
      data
        ? historyGrid(
            data.page,
            rows.map(({ key }) => key),
            data.range.fromMs,
            data.range.toMs,
            false
          )
        : null,
    [data, rows]
  );
  const gaps = useMemo(() => {
    const values = grid?.values[rows[0]?.key ?? ""];
    if (!data || !grid || !values) return [];
    const to = grid.endMs + grid.bucketMs;
    const from = to - values.length * grid.bucketMs;
    return gapBandsModel(
      gapBands(data.page.gaps, from, to, { module: "sensors" }),
      from,
      to
      // Rows are too short for captions; VoiceOver still reads each band.
    ).map((band) => ({ ...band, showCaption: false }));
  }, [data, grid, rows]);
  const temperatures = useHostLive(
    host,
    (s) => rows.map(({ key }) => (live ? held(s, key) : null)),
    shallow
  );
  const extras = useHostLive(
    host,
    (s) =>
      otherSensors.map((key) => (live ? held(s, seriesKeyString(key)) : null)),
    shallow
  );
  if (rows.length === 0) return null;

  const title = zones ? "SoC thermal zones" : "Temperature sensors";
  const format = (value: number | null | undefined) =>
    formatTemperature(value, { units });
  const values = grid?.values;
  const model = heatMatrixModel({
    rows: rows.map((row, index) => ({
      ...row,
      current: temperatures[index] ?? null,
      values: values?.[row.key] ?? [],
    })),
    domain: TEMPERATURE_DOMAIN,
    format,
    accent: "temp",
    ariaLabel: title,
    loading: history.isPending,
  });
  const display = zones
    ? {
        ...model,
        spokenValue: model.rows
          .map(({ label, title, current }) =>
            title ? `${label} (${title}) ${current}` : `${label} ${current}`
          )
          .join(", "),
      }
    : model;
  const clamped = data?.page.clamped.some(
    ({ kind }) => kind === "series" || kind === "bytes"
  );
  return (
    <Card
      className="gap-2"
      testID="thermal-heatmap-layout"
      onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
    >
      <Text variant="cardTitle" accessibilityRole="header">
        {title}
      </Text>
      <HeatMatrix model={display} height={0} gapBands={gaps} sides={sides} />
      {clamped && (
        <ModuleNotice message="History is available for only some temperature sensors." />
      )}
      <HistoryNotice
        query={history}
        hostName={hostName}
        hasSamples={
          values !== undefined &&
          Object.values(values).some((row) =>
            row.some((value) => value !== null)
          )
        }
        showLoading={!history.isPending}
      />
      {otherSensors.length > 0 && (
        <StatList
          items={otherSensors.map((key, index) => ({
            label: labelOf(key, "name") ?? seriesKeyString(key),
            value: format(extras[index]),
          }))}
        />
      )}
    </Card>
  );
});
