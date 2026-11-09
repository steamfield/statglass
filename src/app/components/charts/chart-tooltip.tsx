import type { CSSProperties, ReactNode, Ref } from "react";
import { cn } from "~/lib/utils";
import { Swatch } from "~/widgets/legend";
import { FIELD_LABEL } from "~/widgets/lib/classes";

export interface ChartTooltipShellProps {
  ref?: Ref<HTMLDivElement>;
  hidden?: boolean;
  /** Width and placement ("top-0 w-[220px]"). */
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

/**
 * The frosted card a chart's hover readout sits in. Fill it with
 * `ChartTooltipHead`, `ChartTooltipRows` and `ChartTooltipNote`, and place it
 * with `tooltipBeside` or `tooltipSide`.
 */
export function ChartTooltipShell({
  ref,
  hidden,
  className,
  style,
  children,
}: ChartTooltipShellProps) {
  return (
    <div
      ref={ref}
      hidden={hidden}
      role="tooltip"
      className={cn(
        "pointer-events-none absolute z-10 flex flex-col gap-2 rounded-tile border border-border-strong bg-card/92 p-3 backdrop-blur-md",
        className
      )}
      style={style}
    >
      {children}
    </div>
  );
}

/** The 8 px color mark in front of a series row. */
export function SeriesSwatch({ color }: { color: string }) {
  return <Swatch step="none" color={color} />;
}

/**
 * The tooltip's first line: the moment or span it describes, and what each
 * value is ("5 min avg"). Both slots carry `data-tip` names ("title",
 * "detail") so an imperative readout can fill them with `fillTooltip`.
 */
export function ChartTooltipHead({
  title,
  detail,
}: {
  title?: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span data-tip="title" className="figures text-small">
        {title}
      </span>
      <span data-tip="detail" className={FIELD_LABEL}>
        {detail}
      </span>
    </div>
  );
}

/** The column of series rows. */
export function ChartTooltipRows({
  field,
  children,
}: {
  /** `data-tip` name, so an imperative readout can hide the rows. */
  field?: string;
  children: ReactNode;
}) {
  return (
    <div data-tip={field} className="flex flex-col gap-[5px]">
      {children}
    </div>
  );
}

/** One series: its swatch, its name and its value at the cursor. */
export function ChartTooltipRow({
  color,
  label,
  value,
  field,
}: {
  color?: string | undefined;
  label: ReactNode;
  value?: ReactNode;
  /** `data-tip` name of the value, for `fillTooltip`. */
  field?: string;
}) {
  return (
    <div className="flex items-center gap-2 text-small">
      {color && <SeriesSwatch color={color} />}
      <span className="flex-1 font-normal text-fg-subtle">{label}</span>
      <span data-tip={field} className="figures">
        {value}
      </span>
    </div>
  );
}

/** A line of prose in place of, or under, the rows ("No samples"). */
export function ChartTooltipNote({
  field,
  children,
}: {
  field?: string;
  children?: ReactNode;
}) {
  return (
    <span
      data-tip={field}
      className="font-normal text-muted-foreground text-small"
    >
      {children}
    </span>
  );
}

/** The `data-tip` slot `name` inside `tip`, for an imperative readout. */
export function tooltipField(tip: ParentNode, name: string) {
  return tip.querySelector<HTMLElement>(`[data-tip="${name}"]`);
}

/** Write `text` into the `data-tip` slot `name`, only when it changed. */
export function fillTooltip(tip: ParentNode, name: string, text: string) {
  const el = tooltipField(tip, name);
  if (el && el.textContent !== text) el.textContent = text;
}

/**
 * The one side-flip rule: a tooltip sits on the side of the moment it
 * describes that has more room, right of it in the plot's left half and
 * left of it past the middle, so it never covers the crosshair.
 */
export function tooltipSide(fraction: number): "left" | "right" {
  return fraction > 0.5 ? "left" : "right";
}

const TOOLTIP_GAP_PX = 12;

/**
 * The width and `left`/`right` that place a `width` px tooltip beside a
 * crosshair at `fraction` of a plot starting `inset` px into the tooltip's
 * positioned parent, on the side `tooltipSide` picks. On a plot too narrow
 * for it to fit beside the crosshair, it slides back to the plot's far edge
 * rather than overflow. The unused side is "", so the same object both sets
 * a React style and resets an imperatively placed one.
 */
export function tooltipBeside(
  fraction: number,
  width: number,
  inset = 0
): { width: string; left: string; right: string } {
  const plot = `(100% - ${inset}px)`;
  return tooltipSide(fraction) === "right"
    ? {
        width: `${width}px`,
        left: `max(${inset}px, min(${inset}px + ${plot} * ${fraction} + ${TOOLTIP_GAP_PX}px, 100% - ${width}px))`,
        right: "",
      }
    : {
        width: `${width}px`,
        left: "",
        right: `max(0px, min(${plot} * ${1 - fraction} + ${TOOLTIP_GAP_PX}px, ${plot} - ${width}px))`,
      };
}
