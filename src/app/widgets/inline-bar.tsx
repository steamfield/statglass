import type { InlineBarData } from "@core/widget-models/inline-bar";
import type { RampStep } from "@core/widget-models/tokens";
import { cn } from "~/lib/utils";
import { accentVars, rampBackground } from "./lib/accent";
import { FIELD_LABEL } from "./lib/classes";
import { MeterTrack } from "./meter-track";

/** Props of the label, value and bar row: the shared data contract. */
export type InlineBarProps = InlineBarData;

function Track({
  fraction,
  step,
  height,
}: {
  fraction: number | null;
  step: RampStep;
  height: "h-1" | "h-1.5";
}) {
  return (
    <MeterTrack
      fraction={fraction}
      fill={rampBackground(step)}
      height={height}
      transition
    />
  );
}

/** Label, value and a horizontal bar. */
export function InlineBar({
  label,
  value,
  fraction,
  accent,
  rampStep = 1,
  layout = "stacked",
}: InlineBarProps) {
  const style = accent ? accentVars(accent) : undefined;

  if (layout === "row") {
    return (
      <div
        className="grid grid-cols-[64px_52px_minmax(0,1fr)] items-center gap-2 text-small"
        style={style}
      >
        <span className="font-normal text-fg-subtle">{label}</span>
        <span
          className={cn(
            "figures text-right",
            fraction === null && "text-muted-foreground"
          )}
        >
          {value}
        </span>
        {fraction === "none" ? (
          <span />
        ) : (
          <Track fraction={fraction} step={rampStep} height="h-1" />
        )}
      </div>
    );
  }

  const wide = layout === "wide";
  return (
    <div className="flex flex-col gap-1" style={style}>
      <div className="flex justify-between gap-2">
        <span
          className={
            wide ? "font-normal text-fg-subtle text-label" : FIELD_LABEL
          }
        >
          {label}
        </span>
        <span
          className={cn(
            "figures text-label",
            typeof fraction !== "number" && "text-muted-foreground"
          )}
        >
          {value}
        </span>
      </div>
      {fraction === "none" ? (
        <span aria-hidden className={wide ? "h-1.5" : "h-1"} />
      ) : (
        <Track
          fraction={fraction}
          step={rampStep}
          height={wide ? "h-1.5" : "h-1"}
        />
      )}
    </div>
  );
}
