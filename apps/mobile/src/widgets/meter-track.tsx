import {
  type MeterTrackData,
  type MeterTrackModel,
  meterTrackModel,
} from "@core/widget-models/meter-track";
import type { Accent, ColorRef } from "@core/widget-models/tokens";
import { use } from "react";
import {
  type StyleProp,
  StyleSheet,
  useColorScheme,
  View,
  type ViewStyle,
} from "react-native";
import Svg, { Defs, Path, Pattern, Rect } from "react-native-svg";
import { WidgetAccent } from "./accent";
import { resolveColor } from "./colors";

/** A color or hatched fill, sized by the meter, stack segment or swatch using it. */
export function BarFill({
  color,
  accent,
  className,
  style,
  testID,
}: {
  color: ColorRef;
  accent?: Accent | undefined;
  className: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const scheme = useColorScheme() ?? "light";
  const scope = use(WidgetAccent);
  const paint = resolveColor(color, scheme, accent ?? scope);
  return (
    <View
      testID={testID}
      className={className}
      style={[style, color.kind !== "hatch" && { backgroundColor: paint }]}
    >
      {color.kind === "hatch" && (
        // The SVG fills the measured segment or swatch without changing its layout.
        <Svg
          style={StyleSheet.absoluteFill}
          width="100%"
          height="100%"
          accessible={false}
        >
          <Defs>
            <Pattern
              id="hatch"
              width={4}
              height={4}
              patternUnits="userSpaceOnUse"
            >
              <Path
                d="M-1 1L1-1 M-1 5L5-1 M3 5L5 3"
                stroke={paint}
                strokeWidth={1.5}
              />
            </Pattern>
          </Defs>
          <Rect width="100%" height="100%" fill="url(#hatch)" />
        </Svg>
      )}
    </View>
  );
}

/** Draws an already resolved meter or inline bar track. */
export function MeterTrackView({
  track,
  wide = false,
}: {
  track: MeterTrackModel;
  wide?: boolean;
}) {
  return (
    <View
      testID="meter-track"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className={
        wide
          ? "h-1.5 overflow-hidden rounded-full bg-track"
          : "h-1 overflow-hidden rounded-full bg-track"
      }
    >
      {track.fill !== null && (
        <BarFill
          testID="meter-fill"
          className="h-full overflow-hidden rounded-full"
          color={track.color}
          style={{ width: `${track.fill * 100}%` }}
        />
      )}
    </View>
  );
}

/** A decorative meter whose figure is supplied by its caller. */
export function MeterTrack({
  fraction,
  wide = false,
}: MeterTrackData & { wide?: boolean }) {
  return <MeterTrackView track={meterTrackModel({ fraction })} wide={wide} />;
}
