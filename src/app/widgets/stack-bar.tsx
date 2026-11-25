import { clamp01 } from "@core/chart-math";
import type {
  StackBarData,
  StackBarSegment,
} from "@core/widget-models/stack-bar";
import { Legend } from "./legend";
import { accentVars, rampBackground } from "./lib/accent";

export type { StackBarSegment };

/** Props of the composition bar: the shared data contract. */
export type StackBarProps = StackBarData;

/**
 * Composition bar, 10 px with 1 px gaps (memory, power, frequency residency). A
 * zero-width segment keeps its legend row so a hatched series that is often
 * zero (ANE, compressed) still has its key.
 */
export function StackBar({
  segments,
  accent,
  showLegend = false,
  legendColumns = 2,
  extraLegend = [],
  ariaLabel,
}: StackBarProps) {
  const label =
    ariaLabel ?? segments.map((s) => `${s.label} ${s.value}`).join(", ");
  return (
    <div
      className="flex flex-col gap-2"
      style={accent ? accentVars(accent) : undefined}
    >
      <div
        role="img"
        aria-label={label}
        className="flex h-2.5 gap-px overflow-hidden rounded-mark"
      >
        {segments.every((s) => s.fraction === null) && (
          <span data-missing className="flex-1 bg-track" />
        )}
        {segments.map((s) => {
          if (s.fraction === null) return null;
          const f = clamp01(s.fraction);
          if (f === 0) return null;
          return (
            <span
              key={s.key}
              className={s.step === "track" ? "basis-0 bg-track" : "basis-0"}
              style={{
                flexGrow: f,
                background:
                  s.color ??
                  (s.step === "track" || s.step === "none"
                    ? undefined
                    : rampBackground(s.step)),
              }}
            />
          );
        })}
      </div>
      {showLegend && (
        <Legend
          columns={legendColumns}
          items={[
            ...segments.map((s) => ({
              label: s.label,
              value: s.value,
              step: s.step,
              color: s.color,
            })),
            ...extraLegend.map((e) => ({ ...e, step: "none" as const })),
          ]}
        />
      )}
    </div>
  );
}
