import {
  Children,
  cloneElement,
  Fragment,
  isValidElement,
  type ReactNode,
} from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "./text";
import { useThemeColors } from "./theme-colors";

function listRows(children: ReactNode): ReactNode[] {
  return Children.toArray(children).flatMap((child) => {
    if (
      !isValidElement<{ children?: ReactNode }>(child) ||
      child.type !== Fragment
    )
      return [child];
    return listRows(child.props.children).map((row) =>
      isValidElement(row)
        ? cloneElement(row, { key: `${child.key}/${row.key}` })
        : row
    );
  });
}

export function GroupedList({ children }: { children: ReactNode }) {
  const colors = useThemeColors();
  const rows = listRows(children);
  if (rows.length === 0) return <View />;

  return (
    <View
      className="overflow-hidden rounded-xl border"
      style={{ backgroundColor: colors.card, borderColor: colors.border }}
    >
      {Children.map(rows, (row, index) => (
        <Fragment>
          {index > 0 && (
            <View
              style={{
                height: StyleSheet.hairlineWidth,
                backgroundColor: colors["border-subtle"],
              }}
            />
          )}
          {row}
        </Fragment>
      ))}
    </View>
  );
}

export function ListSection({
  title,
  footer,
  children,
}: {
  title?: string;
  footer?: string;
  children: ReactNode;
}) {
  return (
    <View className="gap-2">
      {title && (
        <Text variant="cardTitle" accessibilityRole="header" className="px-4">
          {title}
        </Text>
      )}
      {children}
      {footer && (
        <Text variant="caption" className="px-4">
          {footer}
        </Text>
      )}
    </View>
  );
}
