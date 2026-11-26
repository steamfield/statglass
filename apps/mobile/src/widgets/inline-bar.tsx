import {
  type InlineBarData,
  type InlineBarModel,
  inlineBarModel,
} from "@core/widget-models/inline-bar";
import { useWindowDimensions, View } from "react-native";
import { Text } from "@/ui/text";
import { MeterTrackView } from "./meter-track";

const ROW_TEXT_ROLE = "label";

/** A label, formatted value and optional meter. */
export function InlineBar(data: InlineBarData | { model: InlineBarModel }) {
  const { label, value, layout, track } =
    "model" in data ? data.model : inlineBarModel(data);
  const { fontScale } = useWindowDimensions();
  const row = layout === "row" && fontScale < 1.5;
  const muted = track?.fill === null || (layout !== "row" && !track);
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
        <Text variant={ROW_TEXT_ROLE} className="shrink">
          {label}
        </Text>
        <Text
          variant={ROW_TEXT_ROLE}
          tone={muted ? "muted" : "default"}
          tabular
          className="shrink text-right"
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
