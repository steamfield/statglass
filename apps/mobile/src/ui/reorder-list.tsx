import * as Haptics from "expo-haptics";
import { type ReactElement, useLayoutEffect, useMemo, useRef } from "react";
import { type AccessibilityActionInfo, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import ReorderableList, {
  NestedReorderableList,
  type ReorderableListDragEndEvent,
  type ReorderableListDragStartEvent,
  type ReorderableListProps,
  type ReorderableListReorderEvent,
  reorderItems,
  useIsActive,
  useReorderableDrag,
} from "react-native-reorderable-list";
import { useMotion } from "./motion";

const HOLD_MS = 400;
const STILL_CELL = { opacity: 1, transform: [] };
type PanGesture = ReturnType<typeof Gesture.Pan>;

export interface ReorderListProps<T> {
  data: readonly T[];
  keyOf(item: T): string;
  itemLabel(item: T): string;
  nested?: boolean;
  renderItem(info: { item: T; index: number; isActive: boolean }): ReactElement;
  onReorder(ids: string[]): void;
  onReleaseWithoutMove?(id: string): void;
}

export function ReorderList<T>({
  data,
  keyOf,
  itemLabel,
  nested,
  renderItem,
  onReorder,
  onReleaseWithoutMove,
}: ReorderListProps<T>) {
  const { fast } = useMotion();
  const List = nested ? NestedReorderableList : ReorderableList;
  const items = useMemo(() => [...data], [data]);
  const pan = useMemo(() => Gesture.Pan().activateAfterLongPress(HOLD_MS), []);
  const pickup = useRef<{
    index: number;
    id: string;
    order: string[];
    destination: number | null;
  } | null>(null);
  const committed = useRef({ items, keyOf, onReorder, onReleaseWithoutMove });

  // The native gesture can still call a callback from before the last reorder.
  useLayoutEffect(() => {
    committed.current = { items, keyOf, onReorder, onReleaseWithoutMove };
  }, [items, keyOf, onReorder, onReleaseWithoutMove]);

  function lift(index: number) {
    const { items, keyOf } = committed.current;
    const order = items.map(keyOf);
    const id = order[index];
    if (id === undefined) return;
    pickup.current = { index, id, order, destination: null };
    impact(Haptics.ImpactFeedbackStyle.Medium);
  }

  function drop({ from, to, cancelled }: ReorderableListDragEndEvent) {
    const lifted = pickup.current;
    if (lifted?.index !== from) return;
    impact(Haptics.ImpactFeedbackStyle.Light);
    if (cancelled || from === to) {
      pickup.current = null;
      const { items, keyOf, onReleaseWithoutMove } = committed.current;
      if (!cancelled && items.some((item) => keyOf(item) === lifted.id)) {
        onReleaseWithoutMove?.(lifted.id);
      }
    } else {
      lifted.destination = to;
    }
  }

  function settle({ from, to }: ReorderableListReorderEvent) {
    const lifted = pickup.current;
    if (lifted?.index !== from || lifted.destination !== to) return;
    pickup.current = null;
    // A drop's positions refer to the order at pickup, even if the data changed.
    const { items, keyOf, onReorder } = committed.current;
    const order = items.map(keyOf);
    if (
      order.length === lifted.order.length &&
      order.every((id, index) => id === lifted.order[index])
    ) {
      onReorder(reorderItems(order, from, to));
    }
  }

  function move({ from, to }: ReorderableListReorderEvent) {
    const { items: order, keyOf: idOf, onReorder: apply } = committed.current;
    if (from !== to && order[from] !== undefined && order[to] !== undefined) {
      apply(reorderItems(order, from, to).map(idOf));
    }
  }

  return (
    <List
      data={items}
      keyExtractor={keyOf}
      scrollEnabled={!nested}
      shouldUpdateActiveItem
      animationDuration={fast}
      {...(fast === 0 && { cellAnimations: STILL_CELL })}
      // The library uses Gesture.Pan() internally. Its declaration resolves
      // PanGesture to the newer Gesture Handler 3 API with the same name.
      panGesture={
        pan as unknown as NonNullable<ReorderableListProps<T>["panGesture"]>
      }
      onDragStart={({ index }: ReorderableListDragStartEvent) => {
        "worklet";
        runOnJS(lift)(index);
      }}
      onDragEnd={(event: ReorderableListDragEndEvent) => {
        "worklet";
        runOnJS(drop)(event);
      }}
      onReorder={settle}
      renderItem={({ item, index }) => (
        <ReorderRow
          index={index}
          count={items.length}
          label={itemLabel(item)}
          pan={pan}
          move={move}
          render={(isActive) => renderItem({ item, index, isActive })}
        />
      )}
    />
  );
}

function impact(style: Haptics.ImpactFeedbackStyle) {
  void Haptics.impactAsync(style).catch((error: unknown) => {
    console.warn("Couldn’t play reorder haptic", error);
  });
}

function ReorderRow({
  index,
  count,
  label,
  pan,
  move,
  render,
}: {
  index: number;
  count: number;
  label: string;
  pan: PanGesture;
  move(event: ReorderableListReorderEvent): void;
  render(isActive: boolean): ReactElement;
}) {
  const drag = useReorderableDrag();
  const isActive = useIsActive();
  const hold = useMemo(
    () =>
      Gesture.LongPress()
        .minDuration(HOLD_MS)
        .simultaneousWithExternalGesture(pan)
        .onStart(() => {
          "worklet";
          drag();
        }),
    [drag, pan]
  );
  const actions: AccessibilityActionInfo[] = [];
  if (index > 0) actions.push({ name: "moveUp", label: "Move up" });
  if (index < count - 1) actions.push({ name: "moveDown", label: "Move down" });

  return (
    <GestureDetector gesture={hold}>
      <View collapsable={false} className="min-h-[44px] justify-center">
        {/* Keep the row's buttons reachable as separate VoiceOver targets. */}
        {actions.length > 0 && (
          <View
            className="absolute inset-0"
            pointerEvents="none"
            accessible
            accessibilityLabel={label}
            accessibilityActions={actions}
            onAccessibilityAction={({ nativeEvent }) => {
              if (nativeEvent.actionName === "moveUp") {
                move({ from: index, to: index - 1 });
              } else if (nativeEvent.actionName === "moveDown") {
                move({ from: index, to: index + 1 });
              }
            }}
          />
        )}
        {render(isActive)}
      </View>
    </GestureDetector>
  );
}
