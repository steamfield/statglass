import { indexAt } from "@core/chart-math";
import { formatHistoryTime, MISSING, resolutionLabel } from "@core/format";
import { gapExplanation } from "@core/history-state";
import { type RefObject, useLayoutEffect, useRef } from "react";
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
import type { GapSpan } from "~/widgets/gap-band";
import { type Accent, accentVars, rampColor } from "~/widgets/lib/accent";

/** The readout's width, px: `tooltipBeside` places and sizes it. */
const TOOLTIP_WIDTH = 220;

/** Label of the first gap that overlaps `[fromMs, toMs)`, if any. */
function gapAt(
  gaps: readonly GapSpan[] | undefined,
  fromMs: number,
  toMs: number
): string | null {
  return gapExplanation(gaps?.find((g) => g.fromMs < toMs && g.toMs > fromMs));
}

export interface MirrorHoverProps {
  /** The bars' box: pointer x is measured against it. */
  plotRef: RefObject<HTMLElement | null>;
  /** Width of the label column left of the bars, px. */
  inset: number;
  count: number;
  firstMs: number;
  bucketMs: number;
  up: readonly (number | null)[];
  down: readonly (number | null)[];
  upLabel: string;
  downLabel: string;
  gaps?: readonly GapSpan[] | undefined;
  format: (v: number) => string;
  accent: Accent;
  live?: boolean;
  dateLabels?: boolean;
}

function hoverCaption(p: MirrorHoverProps, i: number) {
  const from = p.firstMs + i * p.bucketMs;
  const format = (t: number) => formatHistoryTime(t, p.dateLabels ?? false);
  return {
    span:
      p.bucketMs > 1000
        ? `${format(from)}–${format(from + p.bucketMs)}`
        : format(from),
    res:
      p.live !== false && i === p.count - 1
        ? "so far"
        : resolutionLabel(p.bucketMs),
  };
}

/** Fill and place the tooltip and crosshair for bar `i`, or hide them. */
function paint(tip: HTMLElement, p: MirrorHoverProps, i: number | null) {
  const host = tip.parentElement;
  const on = i !== null && i < p.count;
  if (host)
    paintCrosshairs(host, on ? plotLeft((i + 0.5) / p.count, p.inset) : null);
  if (!on) {
    tip.hidden = true;
    return;
  }
  const fromMs = p.firstMs + i * p.bucketMs;
  const u = p.up[i] ?? null;
  const d = p.down[i] ?? null;
  const empty = u === null && d === null;
  const caption = hoverCaption(p, i);
  fillTooltip(tip, "title", caption.span);
  fillTooltip(tip, "detail", caption.res);
  fillTooltip(tip, "up", u === null ? MISSING : p.format(u));
  fillTooltip(tip, "down", d === null ? MISSING : p.format(d));
  fillTooltip(
    tip,
    "note",
    gapAt(p.gaps, fromMs, fromMs + p.bucketMs) ?? "No samples"
  );
  const note = tooltipField(tip, "note");
  const rows = tooltipField(tip, "rows");
  if (note) note.hidden = !empty;
  if (rows) rows.hidden = empty;
  Object.assign(
    tip.style,
    tooltipBeside((i + 0.5) / p.count, TOOLTIP_WIDTH, p.inset)
  );
  tip.hidden = false;
}

/**
 * Hover readout for a mirrored chart: the hovered bar's time span and both
 * sides' averages, in the shared chart tooltip, beside the shared crosshair.
 * A bar with no samples says so, with the gap's reason when one covers it,
 * rather than reading as 0.
 *
 * Like `BrushOverlay`, it listens on its parent and writes the DOM through
 * refs, so a pointer passing over the chart re-renders nothing. Each tick's
 * render repaints it with the new values.
 */
export function MirrorHover(props: MirrorHoverProps) {
  const { upLabel, downLabel, accent } = props;
  const latest = useRef(props);
  const slot = useRef<number | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    latest.current = props;
    if (tipRef.current) paint(tipRef.current, props, slot.current);
  });

  useLayoutEffect(() => {
    const tip = tipRef.current;
    const host = tip?.parentElement;
    if (!tip || !host) return;
    const move = (e: globalThis.PointerEvent) => {
      const p = latest.current;
      const box = p.plotRef.current?.getBoundingClientRect();
      const next =
        box && box.width > 0
          ? indexAt((e.clientX - box.left) / box.width, p.count)
          : null;
      if (next === slot.current) return;
      slot.current = next;
      paint(tip, p, next);
    };
    const leave = () => {
      slot.current = null;
      paint(tip, latest.current, null);
    };
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerleave", leave);
    return () => {
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", leave);
    };
  }, []);

  return (
    <ChartTooltipShell
      ref={tipRef}
      hidden
      className="top-0"
      style={accentVars(accent)}
    >
      <ChartTooltipHead />
      <ChartTooltipNote field="note" />
      <ChartTooltipRows field="rows">
        <ChartTooltipRow color={rampColor(2)} label={upLabel} field="up" />
        <ChartTooltipRow color={rampColor(1)} label={downLabel} field="down" />
      </ChartTooltipRows>
    </ChartTooltipShell>
  );
}
