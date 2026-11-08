import type { CSSProperties, ReactNode } from "react";
import { stagger } from "~/lib/motion/enter";
import { cn } from "~/lib/utils";
import type { Corner } from "~/widgets/lib/accent";

const ORIGINS: readonly Corner[] = ["tl", "tr", "bl", "br"];

/**
 * Glow origin for the card at `index`: top-left, top-right, bottom-left,
 * bottom-right, repeating, so adjacent cards light different corners
 * (design-system.md "Rotating origins").
 */
export function cardOrigin(index: number): Corner {
  return ORIGINS[index % ORIGINS.length] as Corner;
}

export interface CardGridProps<T> {
  items: readonly T[];
  /** Stable key per item (module id, cluster name). */
  getKey: (item: T) => string;
  /** Renders one card; pass `origin` to the card unless it overrides it. */
  children: (item: T, origin: Corner, index: number) => ReactNode;
  /**
   * Minimum column width. Columns fill the row (`auto-fill`), so the
   * Overview gets three columns at 1280 px with the default 300.
   */
  minColumnWidth?: number;
  /** Collapse unused tracks so a partial row shares all available width. */
  fit?: boolean;
}

/**
 * Grid of module cards that assigns rotating glow origins by index. Inside a
 * routed page the cards lift in one at a time (`data-stagger`), continuing the
 * page's reading order.
 */
export function CardGrid<T>({
  items,
  getKey,
  children,
  minColumnWidth = 300,
  fit = false,
}: CardGridProps<T>) {
  return (
    <div
      data-stagger
      className={cn(
        "grid gap-4",
        fit
          ? "grid-cols-[repeat(auto-fit,minmax(var(--col),1fr))]"
          : "grid-cols-[repeat(auto-fill,minmax(var(--col),1fr))]"
      )}
      style={{ "--col": `${minColumnWidth}px` } as CSSProperties}
    >
      {items.map((item, i) => (
        <div
          key={getKey(item)}
          className="min-w-0 [&>*]:h-full"
          style={stagger(i)}
        >
          {children(item, cardOrigin(i), i)}
        </div>
      ))}
    </div>
  );
}
