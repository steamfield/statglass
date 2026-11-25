import { afterEach, jest } from "@jest/globals";
import { act } from "@testing-library/react-native/pure";
import { AppState, type AppStateStatus } from "react-native";

let restoreAppState: (() => void) | undefined;

afterEach(() => {
  restoreAppState?.();
  restoreAppState = undefined;
});

/** Simulates iOS AppState changes in tests without a native runtime. */
export function mockAppState() {
  const listeners = new Set<(state: AppStateStatus) => void>();
  const initialAppState = AppState.currentState;
  restoreAppState ??= () => {
    AppState.currentState = initialAppState;
  };
  AppState.currentState = "active";
  jest
    .spyOn(AppState, "addEventListener")
    .mockImplementation((event, listener) => {
      const notify = (state: AppStateStatus) => listener(state);
      if (event === "change") listeners.add(notify);
      return { remove: () => listeners.delete(notify) };
    });

  return (state: AppStateStatus) =>
    act(() => {
      AppState.currentState = state;
      for (const listener of listeners) listener(state);
    });
}
