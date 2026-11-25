import { jest } from "@jest/globals";
import * as stub from "@test/reanimated-stub";

const { useCallback, useRef } =
  jest.requireActual<typeof import("react")>("react");
const { Easing, ScrollView } =
  jest.requireActual<typeof import("react-native")>("react-native");

// The list and Gesture Handler are real. Keep native Reanimated worklets idle.
export const reanimatedListStub = {
  ...stub,
  __esModule: true,
  default: { ...stub.default, ScrollView },
  Easing,
  useAnimatedReaction: () => {},
  useAnimatedRef: () => useCallback(() => {}, []),
  useAnimatedScrollHandler: () => undefined,
  useDerivedValue: (read: () => unknown) => ({ value: read() }),
  useSharedValue: <T>(initial: T) => {
    const shared = useRef({
      value: initial,
      get() {
        return this.value;
      },
      set(next: T) {
        this.value = next;
      },
    });
    return shared.current;
  },
};
