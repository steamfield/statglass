import type { PlacedAnnotation } from "@core/widget-models/chart-annotation";
import { useColorScheme, View } from "react-native";
import Svg, { Line } from "react-native-svg";
import { themeColors } from "@/theme.generated";
import { Text } from "@/ui/text";

/** Draws fitted labels with a stationary marker or a pill at the event time. */
export function ChartAnnotations({
  annotations,
  widthPx,
  fontScale,
}: {
  annotations: readonly PlacedAnnotation[];
  widthPx: number;
  fontScale: number;
}) {
  const colors = themeColors[useColorScheme() === "dark" ? "dark" : "light"];
  const rowPitch = Math.max(22, Math.ceil(16 * fontScale) + 4);
  return annotations.map((a) => (
    <View
      key={a.key}
      pointerEvents="none"
      className={
        a.side === "end"
          ? "absolute flex-row-reverse items-center"
          : "absolute flex-row items-center"
      }
      style={{
        top: 12 + a.row * rowPitch,
        maxWidth: a.fitPx,
        ...(a.side === "end"
          ? { right: widthPx - a.leftPx - a.fitPx }
          : { left: a.leftPx }),
      }}
    >
      {a.variant === "marker" && (
        <Svg width={1} height={20} accessible={false}>
          <Line
            x1={0.5}
            x2={0.5}
            y2={20}
            stroke={colors["border-strong"]}
            strokeWidth={1}
          />
        </Svg>
      )}
      <Text
        role="caption"
        accessibilityLabel={a.label}
        className={
          a.variant === "pill"
            ? "shrink rounded border border-border bg-card px-1"
            : "mx-1 shrink"
        }
        style={{ color: colors[a.tone] }}
        numberOfLines={1}
        ellipsizeMode={a.more > 0 ? "middle" : "tail"}
      >
        {a.label}
      </Text>
    </View>
  ));
}
