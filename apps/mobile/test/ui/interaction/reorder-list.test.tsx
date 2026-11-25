import "react-native-gesture-handler/jestSetup";
import { afterEach, beforeEach, expect, it, jest } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { act, fireEvent } from "@testing-library/react-native";
import * as Battery from "expo-battery";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import {
  type AccessibilityActionInfo,
  AccessibilityInfo,
  Pressable,
  Text,
} from "react-native";
import { Gesture, State } from "react-native-gesture-handler";
import { fireGestureHandler } from "react-native-gesture-handler/jest-utils";
import ReorderableList, {
  NestedReorderableList,
  type ReorderableListProps,
  ScrollViewContainer,
} from "react-native-reorderable-list";
import { ReorderList } from "@/ui/reorder-list";

jest.mock("react-native-reanimated", () => ({
  ...require("@test/ui/reanimated-list-stub").reanimatedListStub,
  runOnJS: (callback: unknown) => callback,
  runOnUI:
    <Args extends unknown[]>(callback: (...args: Args) => void) =>
    (...args: Args) => {
      setTimeout(() => callback(...args), 0);
    },
}));

// Render the real list, capturing the public callbacks that its UI worklets
// and drop animation would deliver on a phone.
jest.mock("react-native-reorderable-list", () => {
  const list: typeof import("react-native-reorderable-list") =
    jest.requireActual("react-native-reorderable-list");
  return {
    ...list,
    __esModule: true,
    default: jest.fn((props: ReorderableListProps<unknown>) => (
      <list.default {...props} />
    )),
    NestedReorderableList: jest.fn((props: ReorderableListProps<unknown>) => (
      <list.NestedReorderableList {...props} />
    )),
  };
});

const names: Readonly<Record<string, string>> = {
  cpu: "CPU",
  memory: "Memory",
  gpu: "GPU",
};
const initial = Object.keys(names);

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

async function renderList({ nested = false, ids = initial } = {}) {
  const reorder = jest.fn<(ids: string[]) => void>();
  const release = jest.fn<(id: string) => void>();
  const open = jest.fn<(id: string) => void>();
  const impact = jest
    .spyOn(Haptics, "impactAsync")
    .mockResolvedValue(undefined);
  jest.mocked(ReorderableList).mockClear();
  jest.mocked(NestedReorderableList).mockClear();

  function Example({ externalOrder }: { externalOrder?: string[] }) {
    const [order, setOrder] = useState(ids);
    const list = (
      <ReorderList
        data={externalOrder ?? order}
        keyOf={(id) => id}
        itemLabel={(id) => names[id] ?? id}
        nested={nested}
        onReorder={(next) => {
          reorder(next);
          setOrder(next);
        }}
        onReleaseWithoutMove={release}
        renderItem={({ item }) => (
          <Pressable accessibilityRole="button" onPress={() => open(item)}>
            <Text>Open {names[item]}</Text>
          </Pressable>
        )}
      />
    );
    return nested ? <ScrollViewContainer>{list}</ScrollViewContainer> : list;
  }

  const view = await renderWithProviders(<Example />);
  const callbacks = jest.mocked(
    nested ? NestedReorderableList : ReorderableList
  ).mock.lastCall?.[0];
  return {
    ...view,
    callbacks,
    impact,
    open,
    release,
    reorder,
    replaceOrder: (externalOrder: string[]) =>
      view.rerender(<Example externalOrder={externalOrder} />),
  };
}

it("lifts with a medium haptic, then drops with a light haptic and reports the new order once", async () => {
  const { callbacks, impact, release, reorder } = await renderList();
  expect(callbacks).toBeDefined();

  await act(() => callbacks?.onDragStart?.({ index: 0 }));
  expect(impact.mock.calls).toEqual([[Haptics.ImpactFeedbackStyle.Medium]]);
  expect(reorder).not.toHaveBeenCalled();

  await act(() => callbacks?.onDragEnd?.({ from: 0, to: 2, cancelled: false }));
  expect(impact.mock.calls).toEqual([
    [Haptics.ImpactFeedbackStyle.Medium],
    [Haptics.ImpactFeedbackStyle.Light],
  ]);
  expect(release).not.toHaveBeenCalled();

  await act(() => callbacks?.onReorder({ from: 0, to: 2 }));
  expect(reorder.mock.calls).toEqual([[["memory", "gpu", "cpu"]]]);
});

it("releases the lifted item without reordering when the indices match", async () => {
  const { callbacks, impact, release, reorder } = await renderList();
  await act(() => callbacks?.onDragStart?.({ index: 1 }));
  await act(() => callbacks?.onDragEnd?.({ from: 1, to: 1, cancelled: false }));

  expect(release.mock.calls).toEqual([["memory"]]);
  expect(reorder).not.toHaveBeenCalled();
  expect(impact.mock.calls).toEqual([
    [Haptics.ImpactFeedbackStyle.Medium],
    [Haptics.ImpactFeedbackStyle.Light],
  ]);
});

it("lifts before a release in the same frame as long-press recognition", async () => {
  const longPress = jest.spyOn(Gesture, "LongPress");
  const { callbacks, impact, release } = await renderList();
  const created = longPress.mock.results[0];
  if (created?.type !== "return") {
    throw new Error("Expected a long press for the first row");
  }

  const previous = Reflect.get(globalThis, "_WORKLET");
  Reflect.set(globalThis, "_WORKLET", true);
  try {
    await act(() => {
      fireGestureHandler(created.value, [
        { state: State.BEGAN },
        { state: State.ACTIVE },
        { state: State.END },
      ]);
      callbacks?.onDragEnd?.({ from: 0, to: 0, cancelled: false });
    });
  } finally {
    Reflect.set(globalThis, "_WORKLET", previous);
  }

  // A lift queued to a later UI job would miss the pan's one release event.
  expect(release.mock.calls).toEqual([["cpu"]]);
  expect(impact.mock.calls).toEqual([
    [Haptics.ImpactFeedbackStyle.Medium],
    [Haptics.ImpactFeedbackStyle.Light],
  ]);
});

it("releases the item now in the held position after a reorder", async () => {
  const { callbacks, release, reorder } = await renderList();
  await act(() => callbacks?.onDragStart?.({ index: 0 }));
  await act(() => callbacks?.onDragEnd?.({ from: 0, to: 2, cancelled: false }));
  await act(() => callbacks?.onReorder({ from: 0, to: 2 }));

  // The native gesture can retain the callbacks from its first attachment.
  await act(() => callbacks?.onDragStart?.({ index: 0 }));
  await act(() => callbacks?.onDragEnd?.({ from: 0, to: 0, cancelled: false }));

  expect(reorder.mock.calls).toEqual([[["memory", "gpu", "cpu"]]]);
  expect(release.mock.calls).toEqual([["memory"]]);
});

it.each([0, 2])(
  "leaves the order and release action alone when a drag to index %i is cancelled",
  async (to) => {
    const { callbacks, release, reorder } = await renderList();
    await act(() => callbacks?.onDragStart?.({ index: 0 }));
    await act(() => callbacks?.onDragEnd?.({ from: 0, to, cancelled: true }));
    if (to !== 0) await act(() => callbacks?.onReorder({ from: 0, to }));
    expect(reorder).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  }
);

it("drops an outdated move when a row arrives while the drop settles", async () => {
  const { callbacks, release, reorder, replaceOrder } = await renderList();
  await act(() => callbacks?.onDragStart?.({ index: 0 }));
  await act(() => callbacks?.onDragEnd?.({ from: 0, to: 2, cancelled: false }));
  await replaceOrder(["battery", "cpu", "memory", "gpu"]);
  await act(() => callbacks?.onReorder({ from: 0, to: 2 }));
  expect(reorder).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
});

it("leaves the lift and drop still when Low Power Mode is enabled", async () => {
  jest
    .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
    .mockResolvedValue(false);
  jest.spyOn(Battery, "isLowPowerModeEnabledAsync").mockResolvedValue(true);
  const { callbacks } = await renderList();
  expect(callbacks).toMatchObject({
    animationDuration: 0,
    cellAnimations: { opacity: 1, transform: [] },
  });
});

it("still releases the item if the pickup haptic fails", async () => {
  const { callbacks, impact, release, reorder } = await renderList();
  const error = new Error("Haptic engine unavailable");
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  impact.mockRejectedValueOnce(error);

  await act(() => callbacks?.onDragStart?.({ index: 0 }));
  await act(() => callbacks?.onDragEnd?.({ from: 0, to: 0, cancelled: false }));

  expect(warn.mock.calls).toEqual([[expect.any(String), error]]);
  expect(release.mock.calls).toEqual([["cpu"]]);
  expect(reorder).not.toHaveBeenCalled();
});

it("offers only valid VoiceOver moves and moves the named item by one row", async () => {
  const { getByLabelText, getByRole, open, reorder } = await renderList();
  const actions = (item: string): AccessibilityActionInfo[] =>
    getByLabelText(item).props.accessibilityActions;
  expect(actions("CPU").map(({ label }) => label)).toEqual(["Move down"]);
  expect(actions("Memory").map(({ label }) => label)).toEqual([
    "Move up",
    "Move down",
  ]);
  expect(actions("GPU").map(({ label }) => label)).toEqual(["Move up"]);

  for (const [item, label] of [
    ["Memory", "Move up"],
    ["CPU", "Move down"],
  ] as const) {
    const action = actions(item).find((action) => action.label === label);
    if (!action) throw new Error(`Missing "${label}" for ${item}`);
    await fireEvent(getByLabelText(item), "accessibilityAction", {
      nativeEvent: { actionName: action.name },
    });
  }
  expect(reorder.mock.calls).toEqual([
    [["memory", "cpu", "gpu"]],
    [["memory", "gpu", "cpu"]],
  ]);

  await fireEvent.press(getByRole("button", { name: "Open CPU" }));
  expect(open.mock.calls).toEqual([["cpu"]]);
});

it("uses the library's nested list inside its scroll container", async () => {
  const { getByRole } = await renderList({ nested: true });
  expect(jest.mocked(NestedReorderableList).mock.lastCall?.[0]).toMatchObject({
    scrollEnabled: false,
  });
  expect(ReorderableList).not.toHaveBeenCalled();
  expect(getByRole("button", { name: "Open CPU" })).toBeVisible();
});

it("leaves a single row tappable with no adjacent moves", async () => {
  const { getByRole, queryByLabelText, open, reorder } = await renderList({
    ids: ["cpu"],
  });
  const button = getByRole("button", { name: "Open CPU" });
  expect(queryByLabelText("CPU")).toBeNull();
  await fireEvent.press(button);
  expect(open.mock.calls).toEqual([["cpu"]]);
  expect(reorder).not.toHaveBeenCalled();
});
