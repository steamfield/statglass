import type { ReactNode } from "react";
import { Modal, Pressable, View } from "react-native";
import { useMotion } from "./motion";
import { Text } from "./text";

export function Sheet({
  visible,
  title,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  onClose(): void;
  children: ReactNode;
}) {
  const { reduced } = useMotion();
  return (
    <Modal
      animationType={reduced ? "none" : "slide"}
      presentationStyle="pageSheet"
      visible={visible}
      allowSwipeDismissal
      onRequestClose={onClose}
    >
      <View
        accessibilityViewIsModal
        onAccessibilityEscape={onClose}
        className="flex-1 bg-popover px-4 pb-safe"
      >
        <View className="flex-row items-center justify-between gap-4 py-2">
          <Text variant="title" className="shrink">
            {title}
          </Text>
          <Pressable
            accessibilityRole="button"
            className="min-h-touch min-w-touch items-center justify-center active:opacity-70"
            onPress={onClose}
          >
            <Text variant="body" weight="semibold">
              Done
            </Text>
          </Pressable>
        </View>
        {children}
      </View>
    </Modal>
  );
}
