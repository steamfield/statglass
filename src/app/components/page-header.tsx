import type { ReactNode, Ref } from "react";
import { cn } from "~/lib/utils";

export interface PageHeaderProps {
  title: string;
  /** One line of facts ("Apple M4 Pro · 10 performance + 4 efficiency cores"). */
  subtitle?: ReactNode;
  /**
   * Right-aligned controls (the window segmented control on CPU, the status
   * pill on Overview). A fragment's children each sit in the header row.
   */
  actions?: ReactNode;
  /**
   * Makes the title focusable from script (not by Tab), so a page can move
   * focus to its top after scrolling there (Timeline opening a heatmap hour).
   */
  headingRef?: Ref<HTMLHeadingElement>;
}

/**
 * Dashboard page header: a bar pinned to the top of the scrolling page with
 * the 22 px title, a muted fact line after it, and an optional control on
 * the right. No kicker; the subtitle must carry facts. A long subtitle wraps
 * under the title, and controls that don't fit wrap to a second row.
 *
 * The bar lines up with the sidebar's brand row: its first row centers on the
 * brand at 54 px and its bottom hairline continues the brand row's at 72 px,
 * as the sidebar's 10 px inset, 30 px traffic-light strip and brand row add
 * up. The whole bar drags the window except its controls, since the page
 * scrolls and has no title bar of its own.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  headingRef,
}: PageHeaderProps) {
  return (
    <header
      data-tauri-drag-region="deep"
      className="sticky top-0 z-20 -mx-3 flex min-h-[73px] flex-wrap items-center gap-x-4 gap-y-2 border-border-subtle border-b bg-background px-3 pt-[37px] pb-0.5 sm:-mx-6 sm:px-6"
    >
      <div className="flex min-w-[220px] flex-1 flex-wrap items-baseline gap-x-3">
        <h1
          ref={headingRef}
          tabIndex={headingRef ? -1 : undefined}
          className={cn(
            "m-0 font-semibold text-page-title tracking-title",
            headingRef && "outline-none"
          )}
        >
          {title}
        </h1>
        {subtitle && (
          <span className="font-normal text-muted-foreground text-small">
            {subtitle}
          </span>
        )}
      </div>
      {actions}
    </header>
  );
}
