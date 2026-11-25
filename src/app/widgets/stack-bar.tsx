import {
  type StackBarData,
  type StackBarSegment,
  stackBarModel,
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
export function StackBar(data: StackBarProps) {
  const { accent, showLegend, legendColumns = 2 } = data;
  const { ariaLabel, empty, segments, legend } = stackBarModel(data);
  return (
    <div
      className="flex flex-col gap-2"
      style={accent ? accentVars(accent) : undefined}
    >
      <div
        role="img"
        aria-label={ariaLabel}
        className="flex h-2.5 gap-px overflow-hidden rounded-mark"
      >
        {empty && <span data-missing className="flex-1 bg-track" />}
        {segments.map(({ key, grow, color, track }) => {
          const background =
            color.kind === "css"
              ? color.value
              : color.kind === "accent" || color.kind === "hatch"
                ? rampBackground(color.kind === "hatch" ? "hatch" : color.step)
                : undefined;
          return (
            <span
              key={key}
              className={track ? "basis-0 bg-track" : "basis-0"}
              style={{ flexGrow: grow, background }}
            />
          );
        })}
      </div>
      {showLegend && (
        <Legend
          columns={legendColumns}
          items={legend.map(({ label, value, swatch }, index) => ({
            label,
            value,
            step: swatch,
            color: data.segments[index]?.color,
          }))}
        />
      )}
    </div>
  );
}
