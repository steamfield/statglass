import type { PopoverCard } from "@core/popover/card-order";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { HISTORY_MODULES } from "@/data/history";
import {
  usePhoneSettings,
  usePhoneSettingsActions,
} from "@/data/phone-settings";
import { Text } from "@/ui/text";
import { moveCard } from "./card-stack";

function MenuAction({
  label,
  onPress,
}: {
  label: string;
  onPress?: (() => void) | undefined;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: onPress === undefined }}
      disabled={onPress === undefined}
      onPress={onPress}
      className="min-h-[44px] justify-center border-border border-t py-2 active:opacity-70"
    >
      <Text
        {...{ role: "body" }}
        className={onPress ? "text-foreground" : "text-muted-foreground"}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function CardMenu({
  card,
  previous,
  next,
  onClose,
}: {
  card: PopoverCard;
  previous: PopoverCard | undefined;
  next: PopoverCard | undefined;
  onClose: () => void;
}) {
  const compact = usePhoneSettings((state) => state.compact);
  const cardOrder = usePhoneSettings((state) => state.cardOrder);
  const settings = usePhoneSettingsActions();
  const changeDensity = () => {
    settings.set({ compact: { ...compact, [card]: !compact[card] } });
    onClose();
  };
  const move = (neighbor: PopoverCard) => {
    settings.set({ cardOrder: moveCard(cardOrder, card, neighbor) });
    onClose();
  };
  return (
    <Modal transparent animationType="none" onRequestClose={onClose}>
      <View className="flex-1 justify-end bg-overlay">
        <View
          accessibilityViewIsModal
          className="max-h-[85%] rounded-t-3xl border border-border bg-popover pb-safe"
        >
          <ScrollView
            contentContainerClassName="px-5 pb-3 pt-5"
            bounces={false}
          >
            <Text {...{ role: "title" }} className="pb-3">
              {HISTORY_MODULES[card].title} card
            </Text>
            <MenuAction
              label={compact[card] ? "Use expanded card" : "Use compact card"}
              onPress={changeDensity}
            />
            <MenuAction
              label="Move up"
              onPress={previous ? () => move(previous) : undefined}
            />
            <MenuAction
              label="Move down"
              onPress={next ? () => move(next) : undefined}
            />
            <MenuAction label="Done" onPress={onClose} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
