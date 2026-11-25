import { afterEach, expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import * as LocalAuthentication from "expo-local-authentication";
import { AppState, type AppStateStatus } from "react-native";
import DeviceSettings from "@/app/settings/device";
import { AppLockGate } from "@/lock/app-lock-gate";

const initialAppState = AppState.currentState;
afterEach(() => {
  AppState.currentState = initialAppState;
});

function mockAppState() {
  const listeners = new Set<(state: AppStateStatus) => void>();
  AppState.currentState = "active";
  jest
    .spyOn(AppState, "addEventListener")
    .mockImplementation((_type, listener) => {
      listeners.add(listener);
      return {
        remove: () => {
          listeners.delete(listener);
        },
      };
    });
  return (state: AppStateStatus) =>
    act(() => {
      AppState.currentState = state;
      for (const listener of listeners) listener(state);
    });
}

const lockSwitch = () => screen.getByRole("switch", { name: "App Lock" });
const unlock = () => screen.getByRole("button", { name: "Unlock StatGlass" });

test("explains why the app lock is disabled without biometrics or passcode", async () => {
  jest
    .spyOn(LocalAuthentication, "getEnrolledLevelAsync")
    .mockResolvedValue(LocalAuthentication.SecurityLevel.NONE);
  const prompt = jest.spyOn(LocalAuthentication, "authenticateAsync");
  await renderWithProviders(<DeviceSettings />);
  expect(
    await screen.findByText(
      "Set up Face ID or a passcode on this iPhone to use App Lock."
    )
  ).toBeOnTheScreen();
  expect(lockSwitch()).toBeDisabled();
  expect(prompt).not.toHaveBeenCalled();
});

test("enables only after authentication and keeps the stack covered until a successful foreground unlock", async () => {
  const changeState = mockAppState();
  jest
    .spyOn(LocalAuthentication, "getEnrolledLevelAsync")
    .mockResolvedValue(LocalAuthentication.SecurityLevel.SECRET);
  const prompt = jest
    .spyOn(LocalAuthentication, "authenticateAsync")
    .mockResolvedValueOnce({ success: false, error: "user_cancel" })
    .mockResolvedValueOnce({ success: true })
    .mockResolvedValueOnce({ success: false, error: "authentication_failed" })
    .mockResolvedValueOnce({ success: true });
  await renderWithProviders(
    <AppLockGate>
      <DeviceSettings />
    </AppLockGate>
  );
  await waitFor(() => expect(lockSwitch()).toBeEnabled());

  await fireEvent(lockSwitch(), "valueChange", true);
  expect(lockSwitch()).not.toBeChecked();
  await fireEvent(lockSwitch(), "valueChange", true);
  expect(lockSwitch()).toBeChecked();
  expect(prompt).toHaveBeenCalledTimes(2);

  await changeState("inactive");
  expect(screen.queryByRole("switch", { name: "App Lock" })).toBeNull();
  expect(prompt).toHaveBeenCalledTimes(2);
  await changeState("background");
  await changeState("active");
  expect(
    await screen.findByRole("header", { name: "StatGlass is locked" })
  ).toBeOnTheScreen();
  expect(screen.queryByRole("switch", { name: "App Lock" })).toBeNull();
  expect(prompt).toHaveBeenLastCalledWith({
    promptMessage: "Unlock StatGlass",
  });
  await fireEvent.press(unlock());
  expect(lockSwitch()).toBeChecked();
  await fireEvent(lockSwitch(), "valueChange", false);
  await changeState("background");
  await changeState("active");
  expect(lockSwitch()).not.toBeChecked();
  expect(prompt).toHaveBeenCalledTimes(4);
});

test("suppresses a repeat prompt when iOS returns from its cancelled authentication UI", async () => {
  const changeState = mockAppState();
  const pending =
    Promise.withResolvers<LocalAuthentication.LocalAuthenticationResult>();
  const prompt = jest
    .spyOn(LocalAuthentication, "authenticateAsync")
    .mockReturnValue(pending.promise);
  await renderWithProviders(
    <AppLockGate>
      <DeviceSettings />
    </AppLockGate>,
    { settings: { appLock: true } }
  );
  await changeState("inactive");
  await act(() => pending.resolve({ success: false, error: "user_cancel" }));
  await changeState("active");
  expect(unlock()).toBeEnabled();
  expect(prompt).toHaveBeenCalledTimes(1);
});

test("a late success from before backgrounding cannot unlock the new foreground session", async () => {
  const changeState = mockAppState();
  const pending =
    Promise.withResolvers<LocalAuthentication.LocalAuthenticationResult>();
  const newPrompt =
    Promise.withResolvers<LocalAuthentication.LocalAuthenticationResult>();
  const prompt = jest
    .spyOn(LocalAuthentication, "authenticateAsync")
    .mockReturnValueOnce(pending.promise)
    .mockReturnValueOnce(newPrompt.promise);
  await renderWithProviders(
    <AppLockGate>
      <DeviceSettings />
    </AppLockGate>,
    { settings: { appLock: true } }
  );
  await changeState("background");
  await changeState("active");
  await act(() => pending.resolve({ success: true }));
  expect(prompt).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("switch", { name: "App Lock" })).toBeNull();
  await act(() => newPrompt.resolve({ success: true }));
  expect(lockSwitch()).toBeChecked();
});
