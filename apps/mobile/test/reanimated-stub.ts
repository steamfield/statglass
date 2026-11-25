/**
 * A still stand-in for react-native-reanimated. The bundled mock loads
 * the native runtime under jest-expo's iOS resolver and throws, so jest.config
 * maps that path here, and test/setup.ts mocks the package with this module.
 * expo-router's testing library mocks Reanimated with `react-native-reanimated/mock`
 * too, which the mapping also sends here. Animations land on their target at
 * once. Motion tests observe calls into the same stand-in.
 */
import { jest } from "@jest/globals";

const { useCallback, useState } =
  jest.requireActual<typeof import("react")>("react");
const { Easing, ScrollView, View } =
  jest.requireActual<typeof import("react-native")>("react-native");

/** Gesture Handler wraps its detector with this; a still component passes through. */
const createAnimatedComponent = <T>(component: T) => component;

export default { ScrollView, View, createAnimatedComponent };
export { createAnimatedComponent, Easing };
export const ReduceMotion = {
  Never: "never",
  System: "system",
  Always: "always",
};
export const cancelAnimation = () => {};
/**
 * Gesture Handler's hooks for routing events through Reanimated. Returning
 * nothing leaves gestures on its JS handlers, as when Reanimated is absent.
 */
export const isSharedValue = () => false;
export const useHandler = () => undefined;
export const useEvent = () => undefined;
export const useComposedEventHandler = () => undefined;
export const useAnimatedReaction = () => {};
export const useAnimatedRef = () => useCallback(() => {}, []);
export const useAnimatedScrollHandler = () => undefined;
export const useDerivedValue = (read: () => unknown) => ({ value: read() });
export const useAnimatedStyle = (build: () => unknown) => build();
export const useSharedValue = <T>(initial: T) =>
  useState(() => ({
    value: initial,
    get() {
      return this.value;
    },
    set(next: T) {
      this.value = next;
    },
  }))[0];
export const withDelay = (_delay: number, target: number) => target;
export const withRepeat = (target: number) => target;
export const withTiming = (target: number) => target;
