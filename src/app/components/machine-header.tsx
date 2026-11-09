import { type ReactNode, useId } from "react";
import { cn } from "~/lib/utils";
import { Card } from "~/widgets/card";

export interface MachineSpec {
  /** Field label: "Chip", "Memory", "Storage", "Battery", "Model", "Uptime". */
  label: string;
  /** Text, or controls such as click-to-copy addresses. */
  value: ReactNode;
  /** Spans both columns, for a long value (the network's addresses). */
  wide?: boolean;
}

export interface MachineHeaderProps {
  /** "MacBook Pro 14-inch (M4 Pro, 2024)". */
  title: string;
  /** "macOS 27.0.1". */
  osVersion: string;
  /** "27A5320", shown after the version. */
  osBuild?: string;
  /** Two-column spec grid, filled row by row. */
  specs: readonly MachineSpec[];
  /** The card's accessible name. Default "This Mac". */
  ariaLabel?: string;
}

/** CPU total and system traces on the laptop's screen, as on the CPU card. */
const TOTAL =
  "M29 64 L33 63 L37 64 L41 62 L45 63 L49 61 L53 62 L57 60 L61 58 L65 60 L69 55 L73 57 L77 52 L81 56 L85 50 L89 47 L93 53 L97 44 L101 49 L105 38 L109 30 L113 46 L117 42 L121 36 L125 40 L129 34";
const SYSTEM =
  "M29 68 L33 68 L37 68 L41 67 L45 68 L49 67 L53 67 L57 66 L61 66 L65 67 L69 65 L73 66 L77 64 L81 65 L85 63 L89 62 L93 64 L97 61 L101 63 L105 58 L109 55 L113 61 L117 60 L121 57 L125 59 L129 56";
/** The screen's inner bottom edge, where the area fill closes. */
const FLOOR = 72;

/**
 * A MacBook from the front: a lid with a thin bezel and
 * camera notch, the screen showing the CPU card's two traces with the area
 * fill the dashboard draws, and a deck with its thumb groove over a soft
 * contact shadow. Tokens only, so it follows the theme.
 */
function Illustration() {
  const id = useId();
  return (
    <svg
      width="150"
      height="98"
      viewBox="0 0 160 104"
      role="img"
      aria-label="Mac illustration"
      className="shrink-0"
    >
      <defs>
        <linearGradient id={`${id}-lid`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--color-raised)" />
          <stop offset="1" stopColor="var(--color-deep)" />
        </linearGradient>
        <linearGradient id={`${id}-area`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--color-cpu)" stopOpacity="0.35" />
          <stop offset="1" stopColor="var(--color-cpu)" stopOpacity="0" />
        </linearGradient>
        <radialGradient id={`${id}-shadow`}>
          <stop offset="0" stopColor="black" stopOpacity="0.45" />
          <stop offset="1" stopColor="black" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="80" cy="96" rx="74" ry="5" fill={`url(#${id}-shadow)`} />
      {/* Lid */}
      <rect
        x="18.5"
        y="2.5"
        width="123"
        height="82"
        rx="7"
        fill={`url(#${id}-lid)`}
        stroke="var(--color-border-strong)"
      />
      <rect
        x="23"
        y="7"
        width="114"
        height="74"
        rx="3.5"
        fill="var(--color-deep)"
      />
      {[24, 40, 56].map((y) => (
        <path key={y} d={`M29 ${y} H131`} stroke="var(--color-grid)" />
      ))}
      <path d={`${TOTAL} V${FLOOR} H29 Z`} fill={`url(#${id}-area)`} />
      <path
        d={SYSTEM}
        fill="none"
        stroke="var(--color-cpu-2)"
        strokeOpacity="0.45"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <path
        d={TOTAL}
        fill="none"
        stroke="var(--color-cpu-ink)"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="129" cy="34" r="2" fill="var(--color-cpu-ink)" />
      {/* Camera notch */}
      <rect
        x="72"
        y="7"
        width="16"
        height="4"
        rx="2"
        fill="var(--color-raised)"
      />
      {/* Hinge */}
      <path d="M21 85 H139" stroke="var(--color-border-strong)" />
      {/* Deck: a flat slab, wider than the lid, with a rounded front edge */}
      <path
        d="M3.5 86.5 H156.5 V89 Q156.5 92.5 152 92.5 H8 Q3.5 92.5 3.5 89 Z"
        fill="var(--color-raised)"
        stroke="var(--color-border-strong)"
      />
      <rect
        x="67"
        y="86.5"
        width="26"
        height="2.5"
        rx="1.25"
        fill="var(--color-deep)"
      />
    </svg>
  );
}

/**
 * Overview machine header: illustration, model name with macOS
 * version, and a two-column spec grid. Takes display strings because the
 * marketing name, GPU core count and memory type are not in `HostInfo`; the
 * route builds them.
 */
export function MachineHeader({
  title,
  osVersion,
  osBuild,
  specs,
  ariaLabel = "This Mac",
}: MachineHeaderProps) {
  return (
    <Card
      accent="cpu"
      origin="tr"
      variant="chart"
      ariaLabel={ariaLabel}
      className="grid grid-cols-[150px_minmax(0,1fr)] items-center gap-6 px-5 py-4"
    >
      <Illustration />
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="m-0 font-semibold text-title-lg tracking-title">
            {title}
          </h2>
          <span className="font-normal text-body text-muted-foreground">
            {osVersion}
            {osBuild && (
              <span className="figures text-label"> ({osBuild})</span>
            )}
          </span>
        </div>
        <dl className="m-0 grid grid-cols-2 gap-x-8 gap-y-1.5">
          {specs.map((s) => (
            <div
              key={s.label}
              className={cn(
                "flex items-baseline gap-3 border-border-subtle border-b pb-[5px]",
                s.wide && "col-span-2"
              )}
            >
              <dt className="w-[72px] shrink-0 font-normal text-label text-muted-foreground">
                {s.label}
              </dt>
              <dd className="m-0 truncate font-normal text-fg-subtle text-small">
                {s.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </Card>
  );
}
