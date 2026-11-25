import Svg, { Path } from "react-native-svg";
import { useThemeColors } from "@/ui/theme-colors";

export function StatusWarning() {
  const colors = useThemeColors();
  return (
    <Svg width={12} height={12} viewBox="0 0 14 14" accessible={false}>
      <Path
        d="M7 1.5 13 12H1z M7 5v2.5m0 2v.1"
        fill="none"
        stroke={colors["warning-ink"]}
        strokeWidth={1.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
