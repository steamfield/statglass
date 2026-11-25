import {
  type MeterTrackData,
  meterTrackModel,
} from "@core/widget-models/meter-track";
import { cn } from "~/lib/utils";

/**
 * Props of the bar meter: the shared data contract plus the desktop's CSS
 * fill, height, classes and tween.
 */
export interface MeterTrackProps extends MeterTrackData {
  /** CSS background of the fill. Defaults to the accent in scope (`--a`). */
  fill?: string;
  height?: "h-1" | "h-1.5";
  /** Width and display for the track ("inline-block w-12"); block by default. */
  className?: string;
  /**
   * Tween the fill on the per-tick motion token. Off by default: a table of
   * hundreds of rows updating at 1 Hz should not run a tween per row.
   */
  transition?: boolean;
}

/**
 * A rounded track with a fill scaled from the left: a bar meter. Decorative:
 * every caller prints the figure beside it, so it is hidden from assistive tech.
 */
export function MeterTrack({ fraction, ...props }: MeterTrackProps) {
  return (
    <MeterTrackView {...props} fraction={meterTrackModel({ fraction }).fill} />
  );
}

/** Draws a fill already resolved by the meter or inline bar model. */
export function MeterTrackView({
  fraction,
  fill = "var(--a)",
  height = "h-1",
  className,
  transition = false,
}: MeterTrackProps) {
  return (
    <span
      aria-hidden
      data-missing={fraction === null || undefined}
      className={cn(
        "block overflow-hidden rounded-full bg-track",
        height,
        className
      )}
    >
      {fraction !== null && (
        <span
          className={cn(
            "block h-full origin-left rounded-full",
            transition &&
              "transition-transform duration-(--motion-tick) ease-tick"
          )}
          style={{
            background: fill,
            transform: `scaleX(${fraction})`,
          }}
        />
      )}
    </span>
  );
}
