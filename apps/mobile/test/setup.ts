/**
 * Jest setup: stubs the native bindings that only exist inside an iOS binary.
 */
import "react-native-gesture-handler/jestSetup";
import { afterEach, jest } from "@jest/globals";

afterEach(() => {
  jest.restoreAllMocks();
});

// The native safe-area module is unavailable outside a native binary.
jest.mock(
  "react-native-safe-area-context",
  () => require("react-native-safe-area-context/jest/mock").default
);

jest.mock("expo-battery", () => ({
  __esModule: true,
  isLowPowerModeEnabledAsync: async () => false,
  addLowPowerModeListener: (
    listener: (event: import("expo-battery").PowerModeEvent) => void
  ) =>
    require("react-native").DeviceEventEmitter.addListener(
      "mockLowPowerModeChanged",
      listener
    ),
}));

// Reanimated's native runtime is unavailable too; charts render still.
jest.mock("react-native-reanimated", () => require("./reanimated-stub"));
