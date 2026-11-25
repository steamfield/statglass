import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useContext,
  useLayoutEffect,
} from "react";
import { Pressable, StyleSheet, View, type ViewProps } from "react-native";
import { Icon, type IconName } from "./icons";
import { Text } from "./text";
import { useThemeColors } from "./theme-colors";

export interface ListRowProps {
  title: string;
  subtitle?: string;
  glyph?: IconName;
  value?: string;
  accessory?: "chevron" | "checkmark" | "none";
  selected?: boolean;
  destructive?: boolean;
  onPress?: () => void;
  accessibilityRole?: "button" | "link";
  accessibilityHint?: string;
  trailing?: ReactNode;
}

// A swipe action belongs to the row's existing VoiceOver focus target.
export const ListRowActions = createContext<{
  actions: Pick<ViewProps, "accessibilityActions" | "onAccessibilityAction">;
  setRowCount: Dispatch<SetStateAction<number>>;
} | null>(null);

export function ListRow({
  title,
  subtitle,
  glyph,
  value,
  accessory = "none",
  selected = accessory === "checkmark",
  destructive,
  onPress,
  accessibilityRole = "button",
  accessibilityHint,
  trailing,
}: ListRowProps) {
  const colors = useThemeColors();
  const swipe = useContext(ListRowActions);
  const setRowCount = swipe?.setRowCount;
  useLayoutEffect(() => {
    if (!setRowCount) return;
    setRowCount((count) => count + 1);
    return () => setRowCount((count) => count - 1);
  }, [setRowCount]);
  const tint = destructive ? colors.destructive : colors.foreground;
  const destructiveColor = destructive ? { color: tint } : undefined;
  const rowProps = {
    ...swipe?.actions,
    accessible: true,
    accessibilityLabel: subtitle ? `${title}, ${subtitle}` : title,
    accessibilityHint,
    accessibilityState:
      accessory === "checkmark" || selected ? { selected } : undefined,
    accessibilityValue: value === undefined ? undefined : { text: value },
    style: styles.row,
    className: "min-w-0 flex-1 flex-row items-center gap-3 px-4 py-2",
  };
  const content = (
    <>
      {glyph && <Icon name={glyph} size={20} color={tint} />}
      <View className="min-w-0 flex-1">
        <Text variant="body" style={destructiveColor}>
          {title}
        </Text>
        {subtitle && (
          <Text variant="caption" style={destructiveColor}>
            {subtitle}
          </Text>
        )}
      </View>
      {value !== undefined && (
        <Text variant="value" style={[styles.value, destructiveColor]}>
          {value}
        </Text>
      )}
      {accessory === "chevron" && (
        <Icon
          name="chevron.right"
          size={14}
          color={destructive ? tint : colors["muted-foreground"]}
        />
      )}
      {accessory === "checkmark" && selected && (
        <Icon name="checkmark" size={16} color={tint} />
      )}
    </>
  );
  return (
    <View className="flex-row items-center">
      {onPress ? (
        <Pressable
          {...rowProps}
          accessibilityRole={accessibilityRole}
          className={`${rowProps.className} active:bg-secondary`}
          onPress={onPress}
        >
          {content}
        </Pressable>
      ) : (
        <View {...rowProps}>{content}</View>
      )}
      {trailing}
    </View>
  );
}

const styles = StyleSheet.create({
  // A minimum leaves room for multi-line text at accessibility sizes.
  row: { minHeight: 44 },
  value: { maxWidth: "45%", textAlign: "right" },
});
