import { Pressable, StyleSheet } from "react-native";
import { Icon, type IconName } from "./icons";

export function HeaderButton({
  icon,
  accessibilityLabel,
  onPress,
}: {
  icon: IconName;
  accessibilityLabel: string;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={styles.hitArea}
    >
      <Icon name={icon} size={28} />
    </Pressable>
  );
}

// The native header measures its custom view to size the button.
const styles = StyleSheet.create({
  hitArea: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
