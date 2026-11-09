import { OctagonAlert, TriangleAlert } from "lucide-react";
import { type ReactNode, useId } from "react";
import { NumberTicker } from "~/lib/motion/number-ticker";
import { cn } from "~/lib/utils";
import { LinkCard } from "./card";
import { CardNotice } from "./card-notice";
import { Swatch } from "./legend";
import type { Accent, Corner } from "./lib/accent";
import { ProcessList, type ProcessListRow } from "./process-list";
import { StatList, type StatListItem } from "./stat-list";

export interface MetricCardList {
  ariaLabel: string;
  rows: ProcessListRow[];
  note?: string;
  caption?: string;
}

/** A state that needs the user, shown as a chip in the header (design-system.md "Status colors"). */
export interface MetricCardAlert {
  tone: "warn" | "critical";
  text: string;
}

export interface MetricCardProps {
  accent: Accent;
  origin?: Corner;
  title: string;
  value: string;
  unit?: string;
  chart: ReactNode;
  stats: StatListItem[];
  list?: MetricCardList | undefined;
  alert?: MetricCardAlert | undefined;
  notice?: string | undefined;
  href?: string | undefined;
  onOpen?: (href: string) => void;
}

/** A module's current figure, history and live facts. The whole card opens its page. */
export function MetricCard({
  accent,
  origin = "tl",
  title,
  value,
  unit,
  chart,
  stats,
  list,
  alert,
  notice,
  href,
  onOpen,
}: MetricCardProps) {
  const titleId = useId();
  return (
    <LinkCard
      accent={accent}
      origin={origin}
      variant="chart"
      labelledBy={titleId}
      href={href}
      onOpen={onOpen}
      className={cn(
        "flex min-w-0 flex-col gap-3 px-4 py-3.5",
        href !== undefined &&
          "text-inherit no-underline outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      )}
    >
      <header className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Swatch step={1} />
          <h3 id={titleId} className="truncate font-semibold text-body">
            {title}
          </h3>
        </div>
        <span className="flex shrink-0 items-baseline gap-2">
          {alert && <AlertChip {...alert} />}
          <span className="figures-display whitespace-nowrap text-figure">
            <NumberTicker text={value} unit={unit} />
            {unit && (
              <span className="text-label text-muted-foreground">{unit}</span>
            )}
          </span>
        </span>
      </header>
      {notice && <CardNotice text={notice} />}
      <div className="min-h-28">{chart}</div>
      <div className="flex min-h-21 flex-col gap-2">
        {(stats.length > 2 ? [stats.slice(0, 2), stats.slice(2)] : [stats]).map(
          (items) => (
            <StatList
              key={items[0]?.label}
              layout="grid"
              items={items}
              valueClassName="whitespace-nowrap"
            />
          )
        )}
      </div>
      {list && (
        <div className="border-border-subtle border-t pt-2">
          {list.caption && (
            <p className="mb-1.5 text-label text-muted-foreground">
              {list.caption}
            </p>
          )}
          <ProcessList rows={list.rows} ariaLabel={list.ariaLabel} />
          {list.note && (
            <p className="mt-1.5 font-normal text-label text-muted-foreground">
              {list.note}
            </p>
          )}
        </div>
      )}
    </LinkCard>
  );
}

function AlertChip({ tone, text }: MetricCardAlert) {
  const Icon = tone === "warn" ? TriangleAlert : OctagonAlert;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 self-center text-label",
        tone === "warn" ? "text-warning" : "text-destructive"
      )}
    >
      <Icon aria-hidden className="icon-regular size-3" />
      {text}
    </span>
  );
}
