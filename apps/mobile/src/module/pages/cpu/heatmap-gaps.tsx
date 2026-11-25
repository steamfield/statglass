import type { PlacedGapBand } from "@core/widget-models/gap-band";
import { useState } from "react";
import { useWindowDimensions, View } from "react-native";
import { GapBands } from "@/widgets/gap-bands";

export function HeatmapGaps({ bands }: { bands: readonly PlacedGapBand[] }) {
  const { fontScale } = useWindowDimensions();
  const [plot, setPlot] = useState({ width: 0, height: 0 });
  // Leave space for HeatMatrix's Dynamic Type legend and its 4 pt row gap.
  const legendHeight = Math.ceil(13 * Math.min(fontScale, 1.5)) + 4;
  return (
    <View
      pointerEvents="none"
      className="absolute inset-x-0 bottom-0 flex-row gap-2"
      style={{ top: legendHeight }}
    >
      <View className="w-1/5" />
      <View
        className="flex-1 overflow-hidden"
        testID="core-gap-plot"
        onLayout={({
          nativeEvent: {
            layout: { width, height },
          },
        }) => setPlot({ width, height })}
      >
        <GapBands
          bands={bands}
          widthPx={plot.width}
          height={plot.height}
          fontScale={fontScale}
        />
      </View>
      <View className="w-1/5" />
    </View>
  );
}
