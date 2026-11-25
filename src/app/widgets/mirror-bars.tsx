import { cssPercent } from "@core/format";
import {
  type MirrorBarsData,
  mirrorBarsModel,
} from "@core/widget-models/mirror-bars";
import { useReveal } from "~/lib/motion/reveal";
import { cn } from "~/lib/utils";
import { ChartLoading } from "./chart-loading";
import { accentVars, rampColor } from "./lib/accent";
import styles from "./lib/scroll-layer.module.css";
import { useTickScroll } from "./lib/use-tick-scroll";

/** Props of the mirrored bars: the shared data contract. */
export type MirrorBarsProps = MirrorBarsData;

/**
 * Mirrored bars: up above a 1 px axis in the accent at ramp
 * step 2, down below in step 1. A missing sample leaves an empty slot, never a
 * zero-height bar that reads as "idle". Direction is in the aria-label and in
 * the surrounding stat labels (↑ UPLOAD, ↓ DOWNLOAD), never color alone.
 */
export function MirrorBars(data: MirrorBarsProps) {
  const {
    intervalMs,
    tEndMs,
    accent,
    upHeight = 18,
    downHeight = 30,
    loading,
  } = data;
  const {
    slots: n,
    up,
    down,
    upColor,
    downColor,
    ariaLabel,
  } = mirrorBarsModel(data);
  const reveal = useReveal<HTMLDivElement>(loading);
  const upBackground =
    upColor.kind === "accent" ? rampColor(upColor.step) : undefined;
  const downBackground =
    downColor.kind === "accent" ? rampColor(downColor.step) : undefined;
  const shift = cssPercent(1 / n);
  const upRef = useTickScroll<HTMLDivElement>(tEndMs, intervalMs, shift);
  const downRef = useTickScroll<HTMLDivElement>(tEndMs, intervalMs, shift);
  const slots = Array.from({ length: n }, (_, i) => i);
  // Slot keys are positions in the window, not data identity: the window
  // scrolls by a transform, so the same slot index is reused each tick.
  return (
    <div
      ref={reveal}
      role="img"
      aria-busy={loading || undefined}
      aria-label={ariaLabel}
      className="relative overflow-hidden"
      style={accentVars(accent)}
    >
      {/* The axis is frame, not data: it stays put while the bars settle. */}
      <div
        className="absolute inset-x-0 h-px bg-axis"
        style={{ top: upHeight }}
      >
        {loading && <ChartLoading className="inset-0" />}
      </div>
      <div
        data-bars
        data-reveal
        className="flex flex-col gap-px"
        style={{ transformOrigin: `50% ${upHeight}px` }}
      >
        <div
          ref={upRef}
          className={cn("flex items-end gap-0.5", styles.layer)}
          style={{ height: upHeight }}
        >
          {slots.map((i) => (
            <span
              key={i}
              data-gap={(!loading && up[i] == null) || undefined}
              className="flex-1 rounded-t-hair"
              style={{
                height: up[i] ?? 0,
                background: upBackground,
              }}
            />
          ))}
        </div>
        <div
          ref={downRef}
          className={cn("flex items-start gap-0.5", styles.layer)}
          style={{ height: downHeight }}
        >
          {slots.map((i) => (
            <span
              key={i}
              data-gap={(!loading && down[i] == null) || undefined}
              className="flex-1 rounded-b-hair"
              style={{ height: down[i] ?? 0, background: downBackground }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
