import * as Haptics from "expo-haptics";
import { type ReactElement, useLayoutEffect, useMemo, useRef } from "react";
import {
  type AccessibilityActionInfo,
  View,
  type ViewProps,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS, useSharedValue } from "react-native-reanimated";
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
const MOVE_SLOP = 6;
const STILL_CELL = { opacity: 1, transform: [] };
type PanGesture = ReturnType<typeof Gesture.Pan>;
type ReorderAccessibility = Required<
  Pick<ViewProps, "accessibilityActions" | "onAccessibilityAction">
>;

export interface ReorderListProps<T> {
  data: readonly T[];
  keyOf(item: T): string;
  itemLabel(item: T): string;
  isItemMovable?(item: T): boolean;
  accessibilityOnItem?: boolean;
  nested?: boolean;
  renderItem(info: {
    item: T;
    index: number;
    isActive: boolean;
    reorderAccessibility?: ReorderAccessibility;
  }): ReactElement;
  onReorder(ids: string[]): void;
  onReleaseWithoutMove?(id: string): void;
}

export function ReorderList<T>({
  data,
  keyOf,
  itemLabel,
  isItemMovable,
  accessibilityOnItem = false,
  nested,
  renderItem,
  onReorder,
  onReleaseWithoutMove,
}: ReorderListProps<T>) {
  const { fast } = useMotion();
  const List = nested ? NestedReorderableList : ReorderableList;
  const items = useMemo(() => [...data], [data]);
  const movable = useMemo(
    () => items.map((item) => isItemMovable?.(item) ?? true),
    [isItemMovable, items]
  );
  const trackRelease = onReleaseWithoutMove !== undefined;
  const touchOrigin = useSharedValue<{ x: number; y: number } | null>(null);
  const moved = useSharedValue(false);
  const pan = useMemo(() => {
    const gesture = Gesture.Pan().activateAfterLongPress(HOLD_MS);
    if (!trackRelease) return gesture;
    return gesture
      .onTouchesDown(({ allTouches }) => {
        "worklet";
        const touch = allTouches[0];
        if (allTouches.length !== 1 || !touch) return;
        touchOrigin.set({ x: touch.absoluteX, y: touch.absoluteY });
        moved.set(false);
      })
      .onTouchesMove(({ allTouches }) => {
        "worklet";
        const touch = allTouches[0];
        const origin = touchOrigin.get();
        if (!touch || !origin || moved.get()) return;
        if (
          Math.hypot(touch.absoluteX - origin.x, touch.absoluteY - origin.y) >
          MOVE_SLOP
        ) {
          moved.set(true);
        }
      });
  }, [moved, touchOrigin, trackRelease]);
  const pickup = useRef<{
    index: number;
    id: string;
    order: string[];
    destination: number | null;
  } | null>(null);
  const committed = useRef({
    items,
    keyOf,
    movable,
    onReorder,
    onReleaseWithoutMove,
  });

  // The native gesture can still call a callback from before the last reorder.
  useLayoutEffect(() => {
    committed.current = {
      items,
      keyOf,
      movable,
      onReorder,
      onReleaseWithoutMove,
    };
  }, [items, keyOf, movable, onReorder, onReleaseWithoutMove]);

  function lift(index: number) {
    const { items, keyOf, movable } = committed.current;
    const order = items.map(keyOf);
    const id = order[index];
    if (id === undefined || !movable[index]) return;
    pickup.current = { index, id, order, destination: null };
    impact(Haptics.ImpactFeedbackStyle.Medium);
  }

  function drop(
    { from, to, cancelled }: ReorderableListDragEndEvent,
    moved: boolean
  ) {
    const lifted = pickup.current;
    if (lifted?.index !== from) return;
    impact(Haptics.ImpactFeedbackStyle.Light);
    if (cancelled || from === to) {
      pickup.current = null;
      const { items, keyOf, onReleaseWithoutMove } = committed.current;
      if (
        !cancelled &&
        !moved &&
        items.some((item) => keyOf(item) === lifted.id)
      ) {
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
    const { items, keyOf, movable } = committed.current;
    const order = items.map(keyOf);
    if (
      movable[from] &&
      order.length === lifted.order.length &&
      order.every((id, index) => id === lifted.order[index])
    ) {
      move({ from, to });
    }
  }

  function move({ from, to }: ReorderableListReorderEvent) {
    const { items, keyOf, movable, onReorder } = committed.current;
    if (from === to || !movable[from] || items[to] === undefined) return;
    const order = items.map(keyOf);
    const movableIds = new Set(order.filter((_, index) => movable[index]));
    const reordered = reorderItems(order, from, to)
      .filter((id) => movableIds.has(id))
      .values();
    const next = order.map((id) =>
      movableIds.has(id) ? (reordered.next().value ?? id) : id
    );
    if (next.some((id, index) => id !== order[index])) onReorder(next);
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
        runOnJS(drop)(event, trackRelease && moved.get());
      }}
      onReorder={settle}
      renderItem={({ item, index }) => (
        <ReorderRow
          index={index}
          movable={movable}
          accessibilityOnItem={accessibilityOnItem}
          label={itemLabel(item)}
          pan={pan}
          move={move}
          render={(isActive, reorderAccessibility) =>
            renderItem({
              item,
              index,
              isActive,
              ...(reorderAccessibility && { reorderAccessibility }),
            })
          }
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
  movable,
  accessibilityOnItem,
  label,
  pan,
  move,
  render,
}: {
  index: number;
  movable: readonly boolean[];
  accessibilityOnItem: boolean;
  label: string;
  pan: PanGesture;
  move(event: ReorderableListReorderEvent): void;
  render(
    isActive: boolean,
    reorderAccessibility?: ReorderAccessibility
  ): ReactElement;
}) {
  const drag = useReorderableDrag();
  const isActive = useIsActive();
  const canMove = movable[index] ?? false;
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
  if (!canMove) return render(isActive);

  const previous = movable.lastIndexOf(true, index - 1);
  const next = movable.indexOf(true, index + 1);
  const actions: AccessibilityActionInfo[] = [];
  if (index > 0 && previous >= 0)
    actions.push({ name: "moveUp", label: "Move up" });
  if (next >= 0) actions.push({ name: "moveDown", label: "Move down" });
  const reorderAccessibility: ReorderAccessibility = {
    accessibilityActions: actions,
    onAccessibilityAction: ({ nativeEvent }) => {
      if (nativeEvent.actionName === "moveUp" && index > 0 && previous >= 0) {
        move({ from: index, to: previous });
      } else if (nativeEvent.actionName === "moveDown" && next >= 0) {
        move({ from: index, to: next });
      }
    },
  };

  return (
    <GestureDetector gesture={hold}>
      <View collapsable={false} className="min-h-touch justify-center">
        {/* Keep the row's buttons reachable as separate VoiceOver targets. */}
        {!accessibilityOnItem && actions.length > 0 && (
          <View
            className="absolute inset-0"
            pointerEvents="none"
            accessible
            accessibilityLabel={label}
            {...reorderAccessibility}
          />
        )}
        {render(
          isActive,
          accessibilityOnItem ? reorderAccessibility : undefined
        )}
      </View>
    </GestureDetector>
  );
}
