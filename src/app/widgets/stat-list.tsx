import type { StatListData, StatListItem } from "@core/widget-models/stat-list";
import type { CSSProperties } from "react";
import { NumberTicker } from "~/lib/motion/number-ticker";
import { cn } from "~/lib/utils";
import { Swatch } from "./legend";
import { accentVars } from "./lib/accent";
import { FIELD_LABEL } from "./lib/classes";

export type { StatListItem };

/**
 * The shared data contract plus `valueClassName`: extra classes on each
 * grid value cell, such as a min width so a grid that sizes to its content
 * doesn't reflow when 9% becomes 10%. Strips take none.
 */
export type StatListProps = StatListData &
  (
    | { layout?: "strip"; valueClassName?: never }
    | { layout: "grid"; valueClassName?: string }
  );

/** Labelled figures: a field label over each value. */
export function StatList({
  items,
  layout = "strip",
  hero,
  accent,
  valueClassName,
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
      {hero && (
        <div className="flex flex-col gap-0.5">
          <dt className={FIELD_LABEL}>{hero.label}</dt>
          <dd className="figures-display text-hero leading-none tracking-title">
            <NumberTicker text={hero.value} unit={hero.unit} />
            {hero.unit && (
              <span className="text-figure text-muted-foreground">
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
              grid ? "figures text-small" : "figures-display text-figure",
              item.muted && "text-muted-foreground",
              valueClassName
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
                className={cn("text-muted-foreground", !grid && "text-label")}
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
