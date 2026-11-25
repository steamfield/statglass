/**
 * Jest setup: stubs the native bindings that only exist inside an iOS binary.
 */
import { afterEach, jest } from "@jest/globals";

afterEach(() => {
  jest.restoreAllMocks();
});

// The native safe-area module is unavailable outside a native binary.
jest.mock(
  "react-native-safe-area-context",
  () => require("react-native-safe-area-context/jest/mock").default
);

// Reanimated's native runtime is unavailable too; charts render still.
jest.mock("react-native-reanimated", () => require("./reanimated-stub"));
