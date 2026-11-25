import {
  RING_GAUGE_DIMENSIONS,
  ringGaugeModel,
} from "@core/widget-models/ring-gauge";
import { NumberTicker } from "~/lib/motion/number-ticker";
import { cn } from "~/lib/utils";
import { type Accent, accentVars, rampColor } from "./lib/accent";

/** Sizes: 88 (Power rings), 112 (CPU clusters). */
export type RingSize = 88 | 112;

export interface RingGaugeProps {
  /**
   * One or two segments as fractions of the full ring. The second starts where
   * the first ends and is drawn at ramp step 2. `null` is a missing
   * measurement: that segment draws no arc, leaving the track.
   */
  fractions: (number | null)[];
  /** Center figure, already formatted ("18%", "17.6", "3.20"). */
  value: string;
  /** Label under the figure ("load", "GB used", "GHz"). */
  label: string;
  accent: Accent;
  size: RingSize;
}

/**
 * Arc gauge with a centered value. Segments are full-circumference dashes
 * revealed by `stroke-dashoffset` and turned to their start angle, so a change
 * tweens offset and rotation (150 ms, off under reduced motion) and never the
 * dash pattern.
 */
export function RingGauge({
  fractions,
  value,
  label,
  accent,
  size,
}: RingGaugeProps) {
  const model = ringGaugeModel(
    { fractions, value, label, accent },
    RING_GAUGE_DIMENSIONS[size]
  );
  const { radius, strokeWidth, circumference, arcs } = model;
  const c = size / 2;

  return (
    <div
      className="relative shrink-0"
      style={{ ...accentVars(model.accent), width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden
        className="-rotate-90"
      >
        <circle
          cx={c}
          cy={c}
          r={radius}
          fill="none"
          stroke="var(--color-track)"
          strokeWidth={strokeWidth}
        />
        {arcs.map((arc) => (
          <circle
            key={arc.step}
            cx={c}
            cy={c}
            r={radius}
            fill="none"
            stroke={rampColor(arc.step)}
            strokeWidth={strokeWidth}
            strokeLinecap={arc.lineCap}
            strokeDasharray={`${circumference} ${circumference}`}
            strokeDashoffset={arc.offset}
            className="transition-[stroke-dashoffset,transform] duration-(--motion-tick) ease-tick"
            style={{
              transform: `rotate(${arc.angle}deg)`,
              transformOrigin: `${c}px ${c}px`,
            }}
          />
        ))}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-px">
        <span
          className={cn(
            "figures-display tracking-figure",
            size === 88 ? "text-figure-lg" : "text-title"
          )}
        >
          <NumberTicker text={model.figure} unit={model.label} />
        </span>
        <span className="font-normal text-caption text-muted-foreground">
          {model.label}
        </span>
      </div>
    </div>
  );
}
