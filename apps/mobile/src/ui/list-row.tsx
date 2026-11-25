import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useContext,
  useLayoutEffect,
} from "react";
import {
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type ViewProps,
} from "react-native";
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
  /** Put the value under the title even at standard text sizes, for values too long for the trailing column. */
  stackValue?: boolean;
}

/**
 * iOS's accessibility text sizes (AX Medium and up) start near 1.5x. There,
 * as in Settings' value cells, the value moves under the title at full width
 * so neither breaks mid-word.
 */
const ACCESSIBILITY_SCALE = 1.5;

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
  stackValue = false,
}: ListRowProps) {
  const colors = useThemeColors();
  const { fontScale } = useWindowDimensions();
  const stacked =
    value !== undefined && (stackValue || fontScale >= ACCESSIBILITY_SCALE);
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
      <RowText
        title={title}
        subtitle={subtitle}
        below={stacked ? value : undefined}
        style={destructiveColor}
      />
      {value !== undefined && !stacked && (
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

/** The title column: title, optional subtitle, and a value moved under them. */
function RowText({
  title,
  subtitle,
  below,
  style,
}: {
  title: string;
  subtitle: string | undefined;
  below: string | undefined;
  style: { color: string } | undefined;
}) {
  return (
    <View className="min-w-0 flex-1">
      <Text variant="body" style={style}>
        {title}
      </Text>
      {subtitle && (
        <Text variant="caption" style={style}>
          {subtitle}
        </Text>
      )}
      {below !== undefined && (
        <Text variant="value" style={style}>
          {below}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // A minimum leaves room for multi-line text at accessibility sizes.
  row: { minHeight: 44 },
  value: { maxWidth: "45%", textAlign: "right" },
});
