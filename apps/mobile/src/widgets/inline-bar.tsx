import {
  type InlineBarData,
  inlineBarModel,
} from "@core/widget-models/inline-bar";
import { useColorScheme, useWindowDimensions, View } from "react-native";
import { themeColors } from "@/theme.generated";
import { Text } from "@/ui/text";
import { MeterTrackView } from "./meter-track";

const ROW_TEXT_ROLE = "label";

/** A label, formatted value and optional meter. */
export function InlineBar(data: InlineBarData) {
  const { label, value, layout, track } = inlineBarModel(data);
  const { fontScale } = useWindowDimensions();
  const row = layout === "row" && fontScale < 1.5;
  const muted = track?.fill === null || (layout !== "row" && !track);
  const colors = themeColors[useColorScheme() ?? "light"];
  return (
    <View
      testID="inline-bar-layout"
      className={row ? "items-center gap-2" : "gap-1"}
      style={{ flexDirection: row ? "row" : "column" }}
    >
      <View
        className={
          row
            ? "w-1/2 flex-row justify-between gap-2"
            : "flex-row justify-between gap-2"
        }
      >
        <Text role={ROW_TEXT_ROLE} className="shrink">
          {label}
        </Text>
        <Text
          role={ROW_TEXT_ROLE}
          className="shrink text-right"
          // NativeWind drops the CSS font-variant-numeric property.
          style={{
            color: colors[muted ? "muted-foreground" : "foreground"],
            fontVariant: ["tabular-nums"],
          }}
        >
          {value}
        </Text>
      </View>
      {track && (
        <View className={row ? "flex-1" : "self-stretch"}>
          <MeterTrackView track={track} wide={layout === "wide"} />
        </View>
      )}
    </View>
  );
}
