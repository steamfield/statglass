import type { CSSProperties } from "react";
import { NumberTicker } from "~/lib/motion/number-ticker";
import { cn } from "~/lib/utils";
import { Swatch, type SwatchStep } from "./legend";
import { type Accent, accentVars } from "./lib/accent";
import { FIELD_LABEL } from "./lib/classes";

export interface StatListItem {
  label: string;
  value: string;
  /** Muted suffix ("of 72.6 Wh", "W"). */
  unit?: string | undefined;
  /** Muted trailing figures after the value ("2.98 2.71" for load average). */
  secondary?: string | undefined;
  /** Dim the value (Idle on the CPU page, ANE at rest). */
  muted?: boolean;
  /** Legend swatch before the label (popover power: CPU, GPU, ANE, DRAM). */
  swatch?: SwatchStep;
}

export interface StatListProps {
  items: StatListItem[];
  /**
   * `strip` (default): a page's KPI strip above a chart, 15 px figures that
   * count to their next value, wrapping. `grid`: two to four compact 12 px
   * cells in equal columns (popover GPU, battery, power; a host row).
   */
  layout?: "strip" | "grid";
  /** The page's headline figure at hero size (CPU "Total 18%"); strip only. */
  hero?: { label: string; value: string; unit?: string | undefined };
  /** Defaults to the accent in scope; only used by swatches. */
  accent?: Accent;
}

/** Labelled figures: a field label over each value. */
export function StatList({
  items,
  layout = "strip",
  hero,
  accent,
}: StatListProps) {
  const grid = layout === "grid";
  const style: CSSProperties = {
    ...(accent ? accentVars(accent) : {}),
    ...(grid
      ? { gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }
      : {}),
  };
  return (
    <dl
      className={cn(
        grid
          ? "grid gap-2"
          : cn(
              "flex flex-wrap items-end",
              hero ? "gap-x-7 gap-y-3" : "gap-x-6 gap-y-3"
            )
      )}
      style={style}
    >
      {hero && !grid && (
        <div className="flex flex-col gap-0.5">
          <dt className={FIELD_LABEL}>{hero.label}</dt>
          <dd className="figures-display text-[32px] leading-none tracking-[-0.022em]">
            <NumberTicker text={hero.value} unit={hero.unit} />
            {hero.unit && (
              <span className="text-[15px] text-muted-foreground">
                {" "}
                {hero.unit}
              </span>
            )}
          </dd>
        </div>
      )}
      {items.map((item) => (
        <div key={item.label} className="flex flex-col gap-0.5">
          <dt className={cn(FIELD_LABEL, "flex items-center gap-1.5")}>
            {item.swatch && <Swatch step={item.swatch} size={7} />}
            {item.label}
          </dt>
          <dd
            className={cn(
              grid ? "figures text-[12px]" : "figures-display text-[15px]",
              item.muted && "text-muted-foreground"
            )}
          >
            {grid ? (
              item.value
            ) : (
              <NumberTicker text={item.value} unit={item.unit} />
            )}
            {item.secondary && (
              <span className="text-muted-foreground"> {item.secondary}</span>
            )}
            {item.unit && (
              <span
                className={cn("text-muted-foreground", !grid && "text-[11px]")}
              >
                {" "}
                {item.unit}
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
