import { Switch, type SwitchProps, View } from "react-native";
import { Text } from "@/ui/text";
import { useThemeColors } from "@/ui/theme-colors";

export function SettingsSwitchRow({
  label,
  disabled = false,
  ...props
}: Pick<SwitchProps, "value" | "disabled" | "onValueChange"> & {
  label: string;
}) {
  const colors = useThemeColors();
  return (
    <View className="min-h-[44px] flex-row items-center gap-3 px-4 py-2">
      <Text
        variant="body"
        className="flex-1"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {label}
      </Text>
      <Switch
        {...props}
        accessibilityRole="switch"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        disabled={disabled}
        hitSlop={{ top: 7, bottom: 7, left: 0, right: 0 }}
        trackColor={{ true: colors.primary }}
      />
    </View>
  );
}
