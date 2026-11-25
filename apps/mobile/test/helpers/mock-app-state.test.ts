import { afterEach, expect, jest, test } from "@jest/globals";
import { mockAppState } from "@test/helpers/mock-app-state";
import { AppState } from "react-native";

const initialState = AppState.currentState;

afterEach(() => {
  expect(AppState.currentState).toBe(initialState);
});

test("delivers app-state changes to active subscribers and restores the initial state", async () => {
  const changeState = mockAppState();
  expect(AppState.currentState).toBe("active");

  const change = jest.fn(() => AppState.currentState);
  const subscription = AppState.addEventListener("change", change);
  const otherChange = jest.fn();
  const otherSubscription = AppState.addEventListener("change", otherChange);
  const finalState = initialState === "active" ? "inactive" : "active";
  try {
    await changeState("background");
    subscription.remove();
    await changeState(finalState);

    expect(change.mock.calls).toEqual([["background"]]);
    expect(change.mock.results).toEqual([
      { type: "return", value: "background" },
    ]);
    expect(otherChange.mock.calls).toEqual([["background"], [finalState]]);
  } finally {
    subscription.remove();
    otherSubscription.remove();
  }
});
