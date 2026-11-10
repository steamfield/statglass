import { heatmapAlpha } from "@core/chart-math";
import { cssPercent, MISSING } from "@core/format";
import { type CSSProperties, memo, type ReactElement, useRef } from "react";
import { useReveal } from "~/lib/motion/reveal";
import { cn } from "~/lib/utils";
import { ChartLoading } from "./chart-loading";
import { GapBands, type GapSpan } from "./gap-band";
import { type Accent, accentVars } from "./lib/accent";
import { historyTicks } from "./lib/chart-labels";
import { WindowTicks } from "./window-ticks";

export interface HeatMatrixRow {
  /** Row key. */
  id: string;
  /** Short label in the left column ("P0", "Zone 01"). */
  label: string;
  /** Rows are grouped by this; an 8 px gap separates consecutive groups. */
  group?: string;
  /** Tooltip on the label, for detail that does not fit ("PMU tdie4"). */
  title?: string;
  /** Current value, or null when stale. */
  now: number | null;
  /** Oldest first; `null` is no samples. */
  buckets: (number | null)[];
}

export interface HeatMatrixProps {
  /** History for this window is still arriving: draw the frame and the loading mark, no data. */
  loading?: boolean;
  rows: readonly HeatMatrixRow[];
  /** Values at `min` get the faintest tint, at `max` the strongest. */
  scale: { min: number; max: number };
  /** The right column's current value ("34%", "61°"). */
  formatNow: (v: number) => string;
  /** Label column width in px. */
  labelWidth?: number;
  bucketMs: number;
  windowMs: number;
  live?: boolean;
  /**
   * Start of the newest bucket (ms epoch). Cells are then keyed by bucket,
   * so when a column closes and the window slides, existing cells keep
   * their identity and only the new one renders. Without it cells are
   * keyed by position.
   */
  endMs?: number | null;
  accent: Accent;
  ariaLabel: string;
  /**
   * Labelled gaps drawn as one hatched band over every row.
   * Needs `endMs` to place them.
   */
  gaps?: readonly GapSpan[];
}

interface CellProps {
  v: number | null;
  min: number;
  max: number;
}

const Cell = memo(function Cell({ v, min, max }: CellProps) {
  const a = heatmapAlpha(v, max, min);
  return (
    <span
      data-gap={a === null || undefined}
      className={cn(
        "h-2.5 rounded-hair",
        a === null &&
          "bg-gap-hatch-dense group-data-loading:bg-none group-data-loading:bg-track"
      )}
      style={
        a === null
          ? undefined
          : ({
              "--t": cssPercent(a, 0),
              background: "color-mix(in srgb, var(--a) var(--t), transparent)",
            } as CSSProperties)
      }
    />
  );
});

interface ClosedCellsProps {
  values: readonly (number | null)[];
  /** Key of the first cell; the rest count up from it. */
  firstKey: number;
  min: number;
  max: number;
}

const sameCells = (a: ClosedCellsProps, b: ClosedCellsProps) =>
  a.firstKey === b.firstKey &&
  a.min === b.min &&
  a.max === b.max &&
  a.values.length === b.values.length &&
  a.values.every((v, i) => v === b.values[i]);

type CellCache = Map<number, { v: number | null; el: ReactElement }>;

/**
 * The closed columns of one row. Only the newest column changes between
 * closes, so this re-renders when a column closes (or the data changes),
 * not on every tick: a row's 1 Hz cost is one cell, not the whole window.
 * Keyed by bucket, a close renders the one new cell; the others reuse last
 * render's element, so React skips them without building an element or
 * comparing props (on a 16-core CPU page that was ~1,000 elements every 10 s).
 */
const ClosedCells = memo(function ClosedCells({
  values,
  firstKey,
  min,
  max,
}: ClosedCellsProps) {
  const last = useRef<{ min: number; max: number; cells: CellCache }>({
    min,
    max,
    cells: new Map(),
  });
  // A new scale changes every cell's tint, so nothing cached is reusable.
  const reuse =
    last.current.min === min && last.current.max === max
      ? last.current.cells
      : null;
  const next: CellCache = new Map();
  const cells = values.map((v, i) => {
    // The bucket number (or the position, without `endMs`), not the index.
    const key = firstKey + i;
    const prev = reuse?.get(key);
    const el =
      prev && prev.v === v ? (
        prev.el
      ) : (
        <Cell key={key} v={v} min={min} max={max} />
      );
    next.set(key, { v, el });
    return el;
  });
  last.current = { min, max, cells: next };
  return cells;
}, sameCells);

/**
 * A metric over time per row: one row per series, one cell per bucket,
 * alpha `0.06 + t · 0.89` of the accent where `t` is the value's place on
 * `scale`. A bucket with no samples (before app start, inside a gap) is
 * hatched, never the faintest tint. An 8 px gap separates row groups.
 * Takes a formatter, so unlike `CoreHeatmap` its props are not JSON.
 */
export function HeatMatrix({
  live = true,
  rows,
  scale,
  formatNow,
  labelWidth = 28,
  bucketMs,
  windowMs,
  endMs = null,
  accent,
  ariaLabel,
  gaps,
  loading,
}: HeatMatrixProps) {
  const reveal = useReveal(loading);
  const cols = Math.max(1, Math.round(windowMs / bucketMs));
  // Bucket number of the first column, or 0 for positional keys.
  const firstKey = endMs === null ? 0 : Math.floor(endMs / bucketMs) - cols + 1;
  const right = (endMs ?? 0) + bucketMs;
  const ticks = historyTicks(right - cols * bucketMs, right, live, 3);
  // Rows are placed explicitly so the gap band can span the cell column of
  // every row without the auto-placement flowing around it.
  const row = (k: number) => ({ gridRow: k + 1 });
  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className="group grid items-center gap-x-2.5 gap-y-0.5"
      data-loading={loading || undefined}
      style={{
        ...accentVars(accent),
        gridTemplateColumns: `${labelWidth}px minmax(0, 1fr) 40px`,
      }}
    >
      {rows.map((r, k) => {
        const first = k > 0 && r.group !== rows[k - 1]?.group;
        // Right-align: the newest bucket is always the last column.
        const pad = Math.max(0, cols - r.buckets.length);
        const cells = loading
          ? Array<number | null>(cols).fill(null)
          : [
              ...Array<number | null>(pad).fill(null),
              ...r.buckets.slice(-cols),
            ];
        return (
          <div key={r.id} className={cn("contents", first && "[&>*]:mt-2")}>
            <span
              className="figures col-start-1 truncate text-caption text-muted-foreground"
              style={row(k)}
              title={r.title}
            >
              {r.label}
            </span>
            <div
              className={cn("col-start-2 grid gap-px", reveal)}
              style={{
                ...row(k),
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
              }}
            >
              <ClosedCells
                values={cells.slice(0, -1)}
                firstKey={firstKey}
                min={scale.min}
                max={scale.max}
              />
              <Cell
                v={cells[cells.length - 1] ?? null}
                min={scale.min}
                max={scale.max}
              />
            </div>
            <span
              className="figures col-start-3 text-right text-label"
              style={row(k)}
            >
              {r.now == null ? MISSING : formatNow(r.now)}
            </span>
          </div>
        );
      })}
      {!loading &&
        gaps &&
        gaps.length > 0 &&
        endMs !== null &&
        rows.length > 0 && (
          <div
            className="pointer-events-none relative col-start-2 self-stretch"
            style={{ gridRow: `1 / ${rows.length + 1}` }}
          >
            <GapBands
              gaps={gaps}
              rangeFromMs={endMs - (cols - 1) * bucketMs}
              rangeToMs={endMs + bucketMs}
            />
          </div>
        )}
      {loading && rows.length > 0 && (
        <div
          className="pointer-events-none relative col-start-2 self-stretch"
          style={{ gridRow: `1 / ${rows.length + 1}` }}
        >
          <ChartLoading className="inset-x-0 bottom-0" />
        </div>
      )}
      <span className="col-start-1" style={row(rows.length)} />
      <WindowTicks
        ticks={ticks}
        className="col-start-2 pt-1.5"
        style={row(rows.length)}
      />
      <span className="col-start-3" style={row(rows.length)} />
    </div>
  );
}

/** Swatch alphas, faint to strong, when the caller doesn't pass its own. */
const DEFAULT_STOPS = [0.08, 0.35, 0.65, 0.95] as const;

/**
 * The min-to-max swatch legend that sits in a heat matrix card header.
 * `stops` are swatch alphas (0 to 1) on the `heatmapAlpha` ramp.
 */
export function HeatScaleLegend({
  accent = "cpu",
  minLabel = "0%",
  maxLabel = "100%",
  stops = DEFAULT_STOPS,
}: {
  accent?: Accent;
  minLabel?: string;
  maxLabel?: string;
  stops?: readonly number[];
}) {
  return (
    <div
      aria-hidden
      className="flex items-center gap-1"
      style={accentVars(accent)}
    >
      <span className="figures mr-1 text-caption text-muted-foreground">
        {minLabel}
      </span>
      {stops.map((a) => (
        <span
          key={a}
          className="h-2.5 w-3.5 rounded-mark"
          style={{
            background: `color-mix(in srgb, var(--a) ${cssPercent(a, 0)}, transparent)`,
          }}
        />
      ))}
      <span className="figures ml-1 text-caption text-muted-foreground">
        {maxLabel}
      </span>
    </div>
  );
}
