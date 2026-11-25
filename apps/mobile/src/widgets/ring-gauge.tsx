import type { RingGaugeModel } from "@core/widget-models/ring-gauge";
import { useColorScheme, useWindowDimensions, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { Text } from "@/ui/text";
import { resolveColor } from "./colors";

export function RingGauge({
  model,
  size,
}: {
  model: RingGaugeModel;
  size: number;
}) {
  const scheme = useColorScheme() ?? "light";
  const { fontScale } = useWindowDimensions();
  const center = size / 2;
  const { radius, circumference, strokeWidth } = model;
  const figureBelow = fontScale > 1.5;
  const width = figureBelow ? size * fontScale : size;
  const figure = (
    <Text variant="cardFigure" className="text-center">
      {model.figure}
    </Text>
  );
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={model.spoken}
      accessibilityValue={{ text: model.spokenValue }}
      className="items-center gap-1"
      style={{ width, maxWidth: "100%" }}
    >
      <View className="relative" style={{ width: size, height: size }}>
        <Svg accessible={false} height={size} width={size}>
          <Circle
            testID="ring-track"
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={resolveColor({ kind: "token", name: "track" }, scheme)}
            strokeWidth={strokeWidth}
          />
          {model.arcs.map((arc) =>
            arc.length === 0 ? null : (
              <Circle
                key={arc.step}
                testID="ring-arc"
                cx={center}
                cy={center}
                r={radius}
                fill="none"
                stroke={resolveColor(
                  { kind: "accent", step: arc.step, ink: strokeWidth < 4 },
                  scheme,
                  model.accent
                )}
                strokeWidth={strokeWidth}
                strokeLinecap={arc.lineCap}
                strokeDasharray={[circumference, circumference]}
                strokeDashoffset={arc.offset}
                rotation={arc.angle - 90}
                originX={center}
                originY={center}
              />
            )
          )}
        </Svg>
        {!figureBelow && (
          <View className="absolute inset-0 items-center justify-center">
            {figure}
          </View>
        )}
      </View>
      {figureBelow && figure}
      <Text variant="caption" className="text-center">
        {model.label}
      </Text>
      {model.secondary && (
        <Text variant="caption" className="text-center">
          {model.secondary}
        </Text>
      )}
    </View>
  );
}
