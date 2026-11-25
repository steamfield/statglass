import { heatmapAlpha } from "@core/chart-math";
import { formatPercent, MISSING } from "@core/format";
import type { Accent } from "./tokens";

interface HeatRowLabel {
  label: string;
  /** An 8 px gap separates consecutive groups. */
  group?: string;
  /** Detail for a short label. */
  title?: string;
}

export interface HeatMatrixRow extends HeatRowLabel {
  id: string;
  /** Current value, or null when stale. */
  now: number | null;
  /** Oldest first. A null bucket has no samples. */
  buckets: (number | null)[];
}

interface HeatMatrixInputRow extends HeatRowLabel {
  key: string;
  /** Oldest first. A null bucket has no samples. */
  values: readonly (number | null)[];
  /** Current value, independent of the newest historical bucket. */
  current?: number | null;
}

type InputRow = HeatMatrixRow | HeatMatrixInputRow;

export interface HeatMatrixInput {
  rows: readonly InputRow[];
  domain: readonly [number, number];
  format(value: number): string;
  timeline?: {
    bucketMs: number;
    windowMs: number;
    endMs?: number | null;
  };
  loading?: boolean | undefined;
  accent?: Accent;
  ariaLabel?: string;
}

interface HeatMatrixViewRow {
  key: string;
  label: string;
  current: string;
  title: string | undefined;
  startsGroup: boolean;
  values: readonly (number | null)[];
}

export interface HeatMatrixModel {
  cells: readonly { row: number; col: number; alpha: number | null }[];
  rows: readonly HeatMatrixViewRow[];
  /** Projects the rows in a single pass without materializing the row array. */
  mapRows<T>(project: (row: HeatMatrixViewRow, index: number) => T): T[];
  legend: { min: string; max: string; stops: readonly number[] };
  spoken: string;
  spokenValue: string;
  columns: number;
  firstKey: number;
  accent: Accent;
  loading: boolean;
  notice: string | null;
}

const DEFAULT_STOPS = [0.08, 0.35, 0.65, 0.95] as const;

export function heatScaleLegendModel({
  minLabel = formatPercent(0),
  maxLabel = formatPercent(100),
  stops = DEFAULT_STOPS,
}: {
  minLabel?: string | undefined;
  maxLabel?: string | undefined;
  stops?: readonly number[] | undefined;
} = {}): HeatMatrixModel["legend"] {
  return { min: minLabel, max: maxLabel, stops };
}

/** Used by the desktop's memoized cells and by the flat cell model. */
export function heatMatrixCellAlpha(
  value: number | null,
  min: number,
  max: number
): number | null {
  return heatmapAlpha(value, max, min);
}

export function heatMatrixModel({
  rows,
  domain: [min, max],
  format,
  timeline,
  loading = false,
  accent = "cpu",
  ariaLabel = "Heat matrix",
}: HeatMatrixInput): HeatMatrixModel {
  const columns = Math.max(
    1,
    timeline
      ? Math.round(timeline.windowMs / timeline.bucketMs)
      : rows.reduce(
          (longest, row) => Math.max(longest, rowValues(row).length),
          0
        )
  );
  const firstKey =
    timeline?.endMs == null
      ? 0
      : Math.floor(timeline.endMs / timeline.bucketMs) - columns + 1;

  const notice = loading
    ? "Loading history…"
    : rows.length === 0
      ? "No samples in this range"
      : null;
  const viewRow = (row: InputRow, index: number): HeatMatrixViewRow => {
    const current = "id" in row ? row.now : row.current;
    return {
      key: "id" in row ? row.id : row.key,
      label: row.label,
      current: current == null ? MISSING : format(current),
      title: row.title,
      startsGroup: index > 0 && row.group !== rows[index - 1]?.group,
      values: alignValues(rowValues(row), columns, loading),
    };
  };
  let viewRows: readonly HeatMatrixViewRow[] | undefined;
  const getRows = () => (viewRows ??= rows.map(viewRow));

  return {
    get rows() {
      return getRows();
    },
    mapRows(project) {
      return rows.map((row, index) => project(viewRow(row, index), index));
    },
    // The desktop resolves tint inside its memoized cells. Only build the
    // flat projection when a renderer asks for every cell.
    get cells() {
      return getRows().flatMap(({ values }, row) =>
        values.map((value, col) => ({
          row,
          col,
          alpha: heatMatrixCellAlpha(value, min, max),
        }))
      );
    },
    get legend() {
      return heatScaleLegendModel({
        minLabel: format(min),
        maxLabel: format(max),
      });
    },
    spoken: ariaLabel,
    get spokenValue() {
      return (
        getRows()
          .map(({ label, current }) => `${label} ${current}`)
          .join(", ") ||
        notice ||
        ""
      );
    },
    columns,
    firstKey,
    accent,
    loading,
    notice,
  };
}

function rowValues(row: InputRow): readonly (number | null)[] {
  return "buckets" in row ? row.buckets : row.values;
}

function alignValues(
  values: readonly (number | null)[],
  columns: number,
  loading: boolean
): readonly (number | null)[] {
  if (loading) return Array<null>(columns).fill(null);
  const pad = columns - values.length;
  if (pad === 0) return values;
  if (pad < 0) return values.slice(-columns);
  return [...Array<null>(pad).fill(null), ...values];
}
