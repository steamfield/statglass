import { formatHistoryTime, MISSING, resolutionLabel } from "@core/format";
import type { GapBandSpec } from "@core/history-state";
import { gapExplanation } from "@core/history-state";
import {
  ChartTooltipHead,
  ChartTooltipNote,
  ChartTooltipRow,
  ChartTooltipRows,
  ChartTooltipShell,
  fillTooltip,
  tooltipBeside,
  tooltipField,
} from "~/components/charts/chart-tooltip";
import { paintCrosshairs, plotLeft } from "~/components/charts/crosshair-line";
import { usePaintedHover } from "~/components/charts/use-painted-hover";
import { chartY } from "~/widgets/chart-frame";
import { type Accent, accentVars, rampColor } from "~/widgets/lib/accent";

/** The readout's width, px, matching the mirror charts' readout. */
const TOOLTIP_WIDTH = 220;

/** One line of an area chart's hover readout. */
export interface ReadoutRow {
  key: string;
  label: string;
  /** Ramp step of the line it reads (its swatch colour). */
  step: 1 | 2 | 3 | 4;
  /** The values to read, right-aligned to the chart's slots like its lines. */
  values: readonly (number | null)[];
  format: (value: number) => string;
}

/** A drawn line the crosshair marks with a dot. */
export interface ReadoutDot {
  key: string;
  step: 1 | 2 | 3 | 4;
  /** The drawn values (a stacked line's stacked sums). */
  values: readonly (number | null)[];
}

export interface StreamHoverProps {
  /** Points across the plot, oldest first; the last sits at `tEndMs`. */
  slots: number;
  tEndMs: number;
  intervalMs: number;
  yMax: number;
  height: number;
  rows: readonly ReadoutRow[];
  dots: readonly ReadoutDot[];
  gaps?: readonly GapBandSpec[] | undefined;
  accent: Accent;
  /** Hover times carry dates (multi-day or fixed ranges). */
  dateLabels: boolean;
}

/** `values` at `slot`, reading the array right-aligned to `slots`. */
function valueAt(
  values: readonly (number | null)[],
  slots: number,
  slot: number
): number | null {
  return values[slot - (slots - values.length)] ?? null;
}

/** The `data-tip` slot of row `i`; series keys are not selector-safe. */
const rowField = (i: number) => `row-${i}`;

const inkColor = (step: 1 | 2 | 3 | 4) => rampColor(step, "var(--a-ink)");

/** The point under the pointer, `fraction` across the plot. */
const slotAt = (fraction: number, p: StreamHoverProps) =>
  fraction < 0 || fraction > 1 ? null : Math.round(fraction * (p.slots - 1));

/** Move each dot onto its line at `slot`, or hide it. */
function paintDots(tip: HTMLElement, p: StreamHoverProps, slot: number | null) {
  const host = tip.parentElement;
  if (!host) return;
  const left = slot === null ? null : plotLeft(slot / (p.slots - 1));
  p.dots.forEach((d, i) => {
    const el = host.querySelector<HTMLElement>(`[data-readout-dot="${i}"]`);
    if (!el) return;
    const v = slot === null ? null : valueAt(d.values, p.slots, slot);
    el.hidden = left === null || v === null;
    if (left !== null && v !== null) {
      el.style.left = left;
      el.style.top = `${chartY(v, p.yMax, p.height)}px`;
    }
  });
}

/** Fill and place the tooltip, crosshair and dots for `slot`, or hide them. */
function paint(tip: HTMLElement, p: StreamHoverProps, slot: number | null) {
  const host = tip.parentElement;
  const on = slot !== null && p.slots >= 2 && slot < p.slots;
  const fraction = on ? slot / (p.slots - 1) : 0;
  if (host) paintCrosshairs(host, on ? plotLeft(fraction) : null);
  paintDots(tip, p, on ? slot : null);
  if (!on) {
    tip.hidden = true;
    return;
  }
  const t = p.tEndMs - (p.slots - 1 - slot) * p.intervalMs;
  fillTooltip(tip, "title", formatHistoryTime(t, p.dateLabels));
  fillTooltip(tip, "detail", resolutionLabel(p.intervalMs));
  let empty = true;
  p.rows.forEach((r, i) => {
    const v = valueAt(r.values, p.slots, slot);
    if (v !== null) empty = false;
    fillTooltip(tip, rowField(i), v === null ? MISSING : r.format(v));
  });
  const gap = p.gaps?.find((g) => g.fromMs <= t && g.toMs > t);
  fillTooltip(tip, "note", gapExplanation(gap) ?? "No samples");
  const note = tooltipField(tip, "note");
  const rows = tooltipField(tip, "rows");
  if (note) note.hidden = !empty;
  if (rows) rows.hidden = empty;
  Object.assign(tip.style, tooltipBeside(fraction, TOOLTIP_WIDTH));
  tip.hidden = false;
}

/**
 * Hover readout for an area chart: the hovered point's time and each row's
 * value, in the shared chart tooltip, with a dot on each drawn line. A point
 * where every row is missing says so, with the gap's reason when one covers
 * it, rather than reading as 0.
 *
 * Mount it with a painted `CrosshairLine` inside the plot's `relative` box;
 * the pointer is measured against that box.
 * Like `MirrorHover`, a pointer move writes the DOM and re-renders nothing;
 * each tick's render repaints it with the new values.
 */
export function StreamHover(props: StreamHoverProps) {
  const { rows, dots, accent } = props;
  const tipRef = usePaintedHover(props, slotAt, paint);
  return (
    <>
      {dots.map((d, i) => (
        <span
          key={d.key}
          aria-hidden
          hidden
          data-readout-dot={i}
          className="pointer-events-none absolute -mt-1 -ml-[3.5px] size-[7px] rounded-full border-[1.5px] bg-background"
          style={{ borderColor: inkColor(d.step) }}
        />
      ))}
      <ChartTooltipShell
        ref={tipRef}
        hidden
        className="top-0"
        style={accentVars(accent)}
      >
        <ChartTooltipHead />
        <ChartTooltipNote field="note" />
        <ChartTooltipRows field="rows">
          {rows.map((r, i) => (
            <ChartTooltipRow
              key={r.key}
              color={inkColor(r.step)}
              label={r.label}
              field={rowField(i)}
            />
          ))}
        </ChartTooltipRows>
      </ChartTooltipShell>
    </>
  );
}
