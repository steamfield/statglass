import { formatPercent } from "@core/format";
import type { ReactNode } from "react";
import { MeterCell } from "~/components/data-table";
import { InlineMessage } from "~/components/inline-message";
import { SectionCard } from "~/components/section-card";
import type { Accent } from "~/widgets/lib/accent";

/**
 * Parts of the per-app tables: the card shell, notes, the unrecorded-range
 * box, the remainder chip and the share meter the usage, recorded and
 * Network app tables share.
 */

/**
 * The card shell: title with its scope, controls or the pinned
 * selection's chip on the right, then notes and the table edge to edge.
 */
export function AppsShell({
  title,
  aside,
  accent = "net",
  children,
}: {
  title: string;
  aside?: ReactNode;
  accent?: Accent;
  children?: ReactNode;
}) {
  return (
    <SectionCard
      accent={accent}
      origin="tr"
      variant="default"
      title={title}
      aside={aside}
      headerAlign="center"
      compactHeader
      flush
      className="pb-1"
    >
      {children}
    </SectionCard>
  );
}

export function AppsNote({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 pb-2">
      <InlineMessage tone="note">{children}</InlineMessage>
    </div>
  );
}

/**
 * A range with nothing recorded in it: a hatched box with a chip saying so
 * (and, when known, when recording started).
 */
export function UnrecordedRange({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 pt-1 pb-3.5">
      <div className="flex h-33 items-center justify-center rounded-tile border border-border-strong/40 border-dashed bg-gap-hatch">
        <span className="rounded-control border border-border bg-card px-2 py-1 font-normal text-fg-subtle text-label">
          {children}
        </span>
      </div>
    </div>
  );
}

/** The dashed square that marks a remainder row ("System and other"). */
export function OtherChip() {
  return (
    <span
      aria-hidden
      className="inline-block size-4 flex-none rounded-chip border border-border-strong/50 border-dashed"
    />
  );
}

/**
 * A share of the whole, percent: a meter in the card accent and the figure.
 * `muted` greys the meter, for rows that are parts of an app or no app.
 */
export function ShareMeter({
  share,
  muted,
}: {
  share: number | null;
  muted: boolean;
}) {
  return (
    <MeterCell
      fraction={share === null ? null : share / 100}
      fill={muted ? "var(--color-fg-faint)" : "var(--a)"}
    >
      {formatPercent(share, { decimals: 1 })}
    </MeterCell>
  );
}
