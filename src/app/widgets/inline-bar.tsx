import {
  type InlineBarData,
  inlineBarModel,
} from "@core/widget-models/inline-bar";
import type { MeterTrackModel } from "@core/widget-models/meter-track";
import { cn } from "~/lib/utils";
import { accentVars, rampBackground } from "./lib/accent";
import { FIELD_LABEL } from "./lib/classes";
import { MeterTrack } from "./meter-track";

/** Props of the label, value and bar row: the shared data contract. */
export type InlineBarProps = InlineBarData;

function Track({
  track,
  height,
}: {
  track: MeterTrackModel;
  height: "h-1" | "h-1.5";
}) {
  return (
    <MeterTrack
      fraction={track.fill}
      fill={rampBackground(
        track.color.kind === "accent" ? track.color.step : "hatch"
      )}
      height={height}
      transition
    />
  );
}

/** Label, value and a horizontal bar. */
export function InlineBar(data: InlineBarProps) {
  const { accent } = data;
  const { label, value, layout, track } = inlineBarModel(data);
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
            track?.fill === null && "text-muted-foreground"
          )}
        >
          {value}
        </span>
        {track ? <Track track={track} height="h-1" /> : <span />}
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
            (!track || track.fill === null) && "text-muted-foreground"
          )}
        >
          {value}
        </span>
      </div>
      {track ? (
        <Track track={track} height={wide ? "h-1.5" : "h-1"} />
      ) : (
        <span aria-hidden className={wide ? "h-1.5" : "h-1"} />
      )}
    </div>
  );
}
