import { type ReactNode, useRef, useState } from "react";
import { Pressable, View, type ViewProps } from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import { ReduceMotion } from "react-native-reanimated";
import { ListRowActions } from "./list-row";
import { useMotion } from "./motion";
import { Text } from "./text";
import { useThemeColors } from "./theme-colors";

export function SwipeRow({
  children,
  actionLabel,
  onAction,
}: {
  children: ReactNode;
  actionLabel: string;
  onAction(): void;
}) {
  const colors = useThemeColors();
  const { reduced } = useMotion();
  const swipeable = useRef<SwipeableMethods>(null);
  const [rowCount, setRowCount] = useState(0);
  function performAction() {
    swipeable.current?.close();
    onAction();
  }
  const actions: Pick<
    ViewProps,
    "accessibilityActions" | "onAccessibilityAction"
  > = {
    accessibilityActions: [{ name: "remove", label: actionLabel }],
    onAccessibilityAction: ({ nativeEvent }) => {
      if (nativeEvent.actionName === "remove") performAction();
    },
  };

  return (
    <ReanimatedSwipeable
      ref={swipeable}
      overshootRight={false}
      animationOptions={{
        reduceMotion: reduced ? ReduceMotion.Always : ReduceMotion.System,
      }}
      childrenContainerStyle={{ backgroundColor: colors.card }}
      renderRightActions={() => (
        <View
          className="justify-center"
          style={{ backgroundColor: colors.destructive }}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Pressable
            accessibilityRole="button"
            className="flex-1 items-center justify-center px-4"
            // Keep the hit target at 44 pt regardless of the CSS rem size.
            style={{ minHeight: 44, minWidth: 44 }}
            onPress={performAction}
          >
            <Text
              variant="body"
              style={{ color: colors["destructive-foreground"] }}
            >
              {actionLabel}
            </Text>
          </Pressable>
        </View>
      )}
    >
      <ListRowActions.Provider value={{ actions, setRowCount }}>
        {/* Let ListRow keep its own focus target, including through wrappers. */}
        <View accessible={rowCount === 0} {...(rowCount === 0 && actions)}>
          {children}
        </View>
      </ListRowActions.Provider>
    </ReanimatedSwipeable>
  );
}
