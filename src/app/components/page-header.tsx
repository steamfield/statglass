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
 * Dashboard page header: 22 px title, a muted fact line, and
 * an optional control on the right. No kicker; the subtitle must carry facts.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  headingRef,
}: PageHeaderProps) {
  return (
    <header className="flex flex-wrap items-center gap-4">
      <div className="flex min-w-[220px] flex-1 flex-col gap-0.5">
        <h1
          ref={headingRef}
          tabIndex={headingRef ? -1 : undefined}
          className={cn(
            "m-0 font-[590] text-[22px] tracking-[-0.022em]",
            headingRef && "outline-none"
          )}
        >
          {title}
        </h1>
        {subtitle && (
          <span className="font-normal text-[12px] text-muted-foreground">
            {subtitle}
          </span>
        )}
      </div>
      {actions}
    </header>
  );
}
