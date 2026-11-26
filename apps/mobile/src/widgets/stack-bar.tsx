import {
  type StackBarData,
  stackBarModel,
} from "@core/widget-models/stack-bar";
import type { Accent, ColorRef, SwatchStep } from "@core/widget-models/tokens";
import { useWindowDimensions, View } from "react-native";
import { Text } from "@/ui/text";
import { BarFill } from "./meter-track";

/** Legend key shared by the composition bar and the keyed stat cells. */
export function BarSwatch({
  step,
  accent,
}: {
  step: SwatchStep;
  accent?: Accent | undefined;
}) {
  if (step === "none") return <View className="size-2 shrink-0" />;
  const color: ColorRef =
    step === "track"
      ? { kind: "token", name: "track" }
      : step === "hatch"
        ? { kind: "hatch" }
        : { kind: "accent", step, ink: false };
  return (
    <BarFill
      color={color}
      accent={accent}
      className={
        step === "track"
          ? "size-2 shrink-0 rounded-xs border border-border"
          : "size-2 shrink-0 overflow-hidden rounded-xs"
      }
    />
  );
}

/** Composition bar with space for missing and zero readings in its legend. */
export function StackBar(data: StackBarData) {
  const { accent, showLegend, legendColumns = 2 } = data;
  const { ariaLabel, empty, segments, legend } = stackBarModel(data);
  const { fontScale } = useWindowDimensions();
  const columns = fontScale >= 1.5 ? 1 : legendColumns;
  return (
    <View className="gap-2">
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={ariaLabel}
        className="h-2.5 flex-row gap-px overflow-hidden rounded-sm"
      >
        {empty && <View testID="empty-stack" className="flex-1 bg-track" />}
        {segments.map(({ key, color, grow, track }) =>
          color.kind === "token" && !track ? (
            <View
              key={key}
              testID="stack-segment"
              style={{ flexBasis: 0, flexGrow: grow }}
            />
          ) : (
            <BarFill
              key={key}
              testID="stack-segment"
              color={color}
              accent={accent}
              className="overflow-hidden"
              style={{ flexBasis: 0, flexGrow: grow }}
            />
          )
        )}
      </View>
      {showLegend && (
        <View className="flex-row flex-wrap gap-y-1">
          {legend.map(({ key, label, value, swatch }) => (
            <View
              key={key}
              className={
                columns === 2
                  ? "w-1/2 flex-row flex-wrap items-center gap-x-1.5 pr-2"
                  : columns === 1
                    ? "w-full flex-row flex-wrap items-center gap-x-1.5"
                    : "flex-row flex-wrap items-center gap-x-1.5 pr-3"
              }
            >
              <BarSwatch step={swatch} accent={accent} />
              <Text
                variant="caption"
                className={columns === "inline" ? "shrink" : "shrink grow"}
              >
                {label}
              </Text>
              <Text variant="caption" tone="default" tabular className="shrink">
                {value}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
