import { PAUSE_EXPLANATION } from "@core/history-state";
import { CHART_CAPTION_CHAR_WIDTH_PX } from "@core/widget-models/chart-annotation";
import type { PlacedGapBand } from "@core/widget-models/gap-band";
import { useId } from "react";
import { StyleSheet, useColorScheme, View, type ViewStyle } from "react-native";
import Svg, { Defs, G, Path, Pattern, Rect } from "react-native-svg";
import { themeColors } from "@/theme.generated";
import { Text } from "@/ui/text";

const PAUSE_MARK_WIDTH_PX = 9;
// Matches gap-1 between the pause mark and the caption.
const PAUSE_MARK_GAP_PX = 4;

/** Draws the clipped gap spans in the stream's measured plot. */
export function GapBands({
  bands,
  widthPx,
  height,
  fontScale,
}: {
  bands: readonly PlacedGapBand[];
  widthPx: number;
  height: number;
  fontScale: number;
}) {
  const id = useId();
  const colors = themeColors[useColorScheme() === "dark" ? "dark" : "light"];
  if (widthPx <= 0) return null;

  const captions = bands.map((band) => {
    const bandWidth = band.widthFrac * widthPx;
    const pauseMarkSpace = band.paused
      ? PAUSE_MARK_WIDTH_PX + PAUSE_MARK_GAP_PX
      : 0;
    const width = band.showCaption
      ? Math.min(
          widthPx,
          Math.max(
            bandWidth,
            band.label.length * CHART_CAPTION_CHAR_WIDTH_PX * fontScale +
              16 +
              pauseMarkSpace
          )
        )
      : bandWidth;
    const center = (band.leftFrac + band.widthFrac / 2) * widthPx;
    const left = Math.max(0, Math.min(widthPx - width, center - width / 2));
    return { band, left, width };
  });
  const visible = captions
    .filter(({ band }) => band.showCaption)
    .sort((a, b) => a.left - b.left);
  // Keep the hatches anchored when the caption boxes need more space.
  const captionsBelow = visible.some(({ left }, i) => {
    const previous = visible[i - 1];
    return previous && previous.left + previous.width + 4 > left;
  });

  return (
    <>
      <Svg
        width="100%"
        height={height}
        accessible={false}
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
      >
        <Defs>
          <Pattern id={id} width={10} height={10} patternUnits="userSpaceOnUse">
            <Path d="M-1,1L1,-1M0,10L10,0M9,11L11,9" stroke={colors.grid} />
          </Pattern>
        </Defs>
        {bands.map(({ key, leftFrac, widthFrac }) => {
          const x = leftFrac * widthPx;
          const width = widthFrac * widthPx;
          return (
            <G key={key}>
              <Rect x={x} width={width} height={height} fill={`url(#${id})`} />
              <Path
                d={`M${x},0V${height}M${x + width},0V${height}`}
                stroke={colors["border-strong"]}
                strokeDasharray={[3, 2]}
              />
            </G>
          );
        })}
      </Svg>
      {captions.map(({ band, left, width }) => (
        <GapCaption
          key={band.key}
          band={band}
          color={colors["fg-subtle"]}
          position={
            captionsBelow && band.showCaption
              ? undefined
              : { left, width, height }
          }
        />
      ))}
    </>
  );
}

function GapCaption({
  band,
  color,
  position,
}: {
  band: PlacedGapBand;
  color: string;
  position: ViewStyle | undefined;
}) {
  return (
    <View
      accessible
      role="note"
      accessibilityLabel={band.paused ? PAUSE_EXPLANATION : band.label}
      pointerEvents="none"
      className={position ? "absolute top-0 justify-end" : "mt-1 items-start"}
      style={position}
    >
      {band.showCaption && (
        <View className="flex-row items-center justify-center gap-1">
          {band.paused && (
            <Svg width={PAUSE_MARK_WIDTH_PX} height={10}>
              <Path d="M2,1V9M7,1V9" stroke={color} strokeWidth={2} />
            </Svg>
          )}
          <Text
            variant="caption"
            tone="subtle"
            className="shrink"
            numberOfLines={position ? 1 : undefined}
          >
            {band.label}
          </Text>
        </View>
      )}
    </View>
  );
}
