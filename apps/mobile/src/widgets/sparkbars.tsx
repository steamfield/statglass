import type { MirrorBarsData } from "@core/widget-models/mirror-bars";
import { MirrorBarsPlot } from "./mirror-bars";

export function Sparkbars({
  data,
  height,
  accessibilityLabel,
}: {
  data: MirrorBarsData;
  height: number;
  accessibilityLabel: string;
}) {
  // The stationary axis occupies one point between the two halves.
  const halfHeight = (height - 1) / 2;
  return (
    <MirrorBarsPlot
      {...data}
      ariaLabel={accessibilityLabel}
      upHeight={halfHeight}
      downHeight={halfHeight}
    />
  );
}
