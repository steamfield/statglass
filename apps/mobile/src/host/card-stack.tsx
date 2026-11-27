/** Ordered module cards and their controls on the host screen. */
import type { HostRecord } from "@core/generated/types";
import type { HostLive } from "@core/live-state";
import { moduleState } from "@core/module-state";
import { type PopoverCard, popoverSlots } from "@core/popover/card-order";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { memo, useMemo } from "react";
import {
  type AccessibilityActionInfo,
  ActionSheetIOS,
  View,
} from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  withTiming,
} from "react-native-reanimated";
import { UnavailableCard } from "@/cards/unavailable-card";
import { isHistoryModule, MODULE_TITLES } from "@/data/history";
import { useHostLive } from "@/data/live";
import {
  usePhoneSettings,
  usePhoneSettingsActions,
} from "@/data/phone-settings";
import { Entrance } from "@/ui/entrance";
import { useMotion } from "@/ui/motion";
import { ReorderList } from "@/ui/reorder-list";
import { LiveCard } from "./live-card";

const selectCapabilities = ({ capabilities }: HostLive) => capabilities;

const cardModuleStates = (capabilities: HostLive["capabilities"]) => ({
  cpu: moduleState(capabilities, null, "cpu"),
  memory: moduleState(capabilities, null, "memory"),
  gpu: moduleState(capabilities, null, "gpu"),
  power: moduleState(capabilities, null, "power"),
  network: moduleState(capabilities, null, "network"),
  battery: moduleState(capabilities, null, "battery"),
  disk: moduleState(capabilities, null, "disk"),
});

const cardIds: PopoverCard[] = [
  "cpu",
  "memory",
  "gpu",
  "power",
  "network",
  "battery",
];
const slotId = (slot: ReturnType<typeof popoverSlots>[number]) =>
  slot.kind === "card" ? slot.card : slot.module;
const canMoveSlot = (slot: ReturnType<typeof popoverSlots>[number]) =>
  slot.kind === "card";
const slotLabel = (slot: ReturnType<typeof popoverSlots>[number]) => {
  const id = slotId(slot);
  return isHistoryModule(id) ? MODULE_TITLES[id] : "Disk";
};
const selectOrder = (settings: { cardOrder: PopoverCard[] | null }) =>
  settings.cardOrder;
const selectDensity = (settings: { compact: Record<PopoverCard, boolean> }) =>
  settings.compact;

const cardActions: AccessibilityActionInfo[] = [
  { name: "toggleCompact", label: "Toggle compact" },
  { name: "open", label: "Open" },
];
const moveToTopAction: AccessibilityActionInfo = {
  name: "moveToTop",
  label: "Move to top",
};

/**
 * Render a host's module cards with their order and density controls.
 * @throws If a card has no matching controls.
 */
export const CardStack = memo(function CardStack({
  host,
  dimmed,
}: {
  host: HostRecord;
  dimmed: boolean;
}) {
  const { id } = host;
  const router = useRouter();
  const { set } = usePhoneSettingsActions();
  const cardOrder = usePhoneSettings(selectOrder);
  const compact = usePhoneSettings(selectDensity);
  const capabilities = useHostLive(id, selectCapabilities);
  const modules = useMemo(() => cardModuleStates(capabilities), [capabilities]);
  const { fast, easeOut } = useMotion();
  const opacity = useAnimatedStyle(() => {
    const target = dimmed ? 0.5 : 1;
    return {
      opacity:
        fast === 0
          ? target
          : withTiming(target, {
              duration: fast,
              easing: Easing.bezier(...easeOut),
            }),
    };
  });
  const slots = useMemo(() => {
    const slots = popoverSlots(modules);
    if (cardOrder === null) return slots;
    const order = [...new Set([...cardOrder, ...cardIds])];
    const rank = new Map(order.map((card, index) => [card, index]));
    const slotRank = (slot: ReturnType<typeof popoverSlots>[number]) => {
      const card = slotId(slot);
      return isHistoryModule(card)
        ? (rank.get(card) ?? order.length)
        : order.length;
    };
    return slots.sort((a, b) => slotRank(a) - slotRank(b));
  }, [modules, cardOrder]);

  const controls = useMemo(
    () =>
      new Map(
        cardIds.map((card) => [
          card,
          {
            onOpen: () =>
              router.push({
                pathname: "/(hosts)/[host]/[module]",
                params: { host: id, module: card },
              }),
            onToggleDensity: () => {
              set(({ compact }) => ({
                compact: { ...compact, [card]: !compact[card] },
              }));
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(
                (error: unknown) =>
                  console.warn("Couldn’t play card density haptic", error)
              );
            },
            // The scaffold Pressable needs a handler to keep a hold from also opening.
            onLongPress: () => {},
          },
        ])
      ),
    [id, router, set]
  );

  function reorder(ids: string[]) {
    const visible = ids.filter(
      (id): id is PopoverCard => isHistoryModule(id) && modules[id] === "on"
    );
    const shown = new Set(visible);
    set(({ cardOrder }) => {
      // Refill only the visible positions, preserving hidden cards for other hosts.
      const current = [...new Set([...(cardOrder ?? []), ...cardIds])];
      const reordered = visible.values();
      return {
        cardOrder: current.map((card) =>
          shown.has(card) ? (reordered.next().value ?? card) : card
        ),
      };
    });
  }

  function moveToTop(card: PopoverCard) {
    reorder([card, ...slots.map(slotId).filter((id) => id !== card)]);
  }

  function showMenu(id: string) {
    if (!isHistoryModule(id) || modules[id] !== "on") return;
    const control = controls.get(id);
    if (!control) return;
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: [
          compact[id] ? "Expand" : "Compact",
          `Open ${MODULE_TITLES[id]}`,
          "Move to top",
          "Cancel",
        ],
        cancelButtonIndex: 3,
      },
      (index) => {
        if (index === 0) control.onToggleDensity();
        if (index === 1) control.onOpen();
        if (index === 2) moveToTop(id);
      }
    );
  }

  return (
    <Animated.View accessibilityLabel="Module cards" style={opacity}>
      <ReorderList
        nested
        data={slots}
        keyOf={slotId}
        itemLabel={slotLabel}
        isItemMovable={canMoveSlot}
        accessibilityOnItem
        onReorder={reorder}
        onReleaseWithoutMove={showMenu}
        renderItem={({ item, index, reorderAccessibility }) => {
          const spacing = index === 0 ? "" : "pt-2";
          if (item.kind === "unavailable") {
            return (
              <View className={spacing}>
                <Entrance>
                  <UnavailableCard module={item.module} state={item.state} />
                </Entrance>
              </View>
            );
          }
          const { card } = item;
          const control = controls.get(card);
          if (!control) throw new Error(`Missing controls for ${card}`);
          const moveActions = reorderAccessibility?.accessibilityActions ?? [];
          const canMoveToTop = moveActions.some(
            ({ name }) => name === "moveUp"
          );
          return (
            <View className={spacing}>
              <Entrance>
                <LiveCard
                  {...control}
                  card={card}
                  host={id}
                  compact={compact[card]}
                  stale={dimmed}
                  totalBytes={host.info.mem_total_bytes}
                  includeBattery={modules.battery === "on"}
                  macOs={host.info.os === "mac_os"}
                  accessibilityActions={[
                    ...cardActions,
                    ...moveActions,
                    ...(canMoveToTop ? [moveToTopAction] : []),
                  ]}
                  onAccessibilityAction={(event) => {
                    const { nativeEvent } = event;
                    if (nativeEvent.actionName === "toggleCompact")
                      control.onToggleDensity();
                    else if (nativeEvent.actionName === "open")
                      control.onOpen();
                    else if (
                      nativeEvent.actionName === "moveToTop" &&
                      canMoveToTop
                    )
                      moveToTop(card);
                    else reorderAccessibility?.onAccessibilityAction?.(event);
                  }}
                />
              </Entrance>
            </View>
          );
        }}
      />
    </Animated.View>
  );
});
