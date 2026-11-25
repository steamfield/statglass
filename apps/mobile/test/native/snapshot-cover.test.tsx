import { beforeEach, expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import {
  fireEvent,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react-native";
import * as LocalAuthentication from "expo-local-authentication";
import { useLayoutEffect } from "react";
import DeviceSettings from "@/app/settings/device";
import { usePhoneSettings } from "@/data/phone-settings";
import { AppLockGate } from "@/lock/app-lock-gate";
import { useSnapshotCover } from "@/lock/snapshot-cover";

jest.mock("@native/statglass-native", () => ({
  getStatglassNative: () =>
    mockNativeAvailable ? { setSnapshotCover: mockSetSnapshotCover } : null,
}));

const mockSetSnapshotCover = jest.fn<(enabled: boolean) => void>();
let mockNativeAvailable: boolean;

beforeEach(() => {
  mockSetSnapshotCover.mockReset();
  mockNativeAvailable = true;
});

test("forwards the initial flag and one update per change", async () => {
  const { rerender } = await renderHook(useSnapshotCover, {
    initialProps: true,
  });
  expect(mockSetSnapshotCover.mock.calls).toEqual([[true]]);

  await rerender(false);
  await rerender(false);
  expect(mockSetSnapshotCover.mock.calls).toEqual([[true], [false]]);
});

test("can mount and update without a native module", async () => {
  mockNativeAvailable = false;
  const { rerender } = await renderHook(useSnapshotCover, {
    initialProps: true,
  });
  await rerender(false);
  expect(mockSetSnapshotCover).not.toHaveBeenCalled();
});

test.each([true, false])(
  "the app lock gate forwards the %s setting",
  async (appLock) => {
    jest
      .spyOn(LocalAuthentication, "authenticateAsync")
      .mockResolvedValue({ success: false, error: "user_cancel" });
    await renderWithProviders(<AppLockGate>{null}</AppLockGate>, {
      settings: { appLock },
    });
    expect(mockSetSnapshotCover.mock.calls).toEqual([[appLock]]);
  }
);

test("enabling App Lock arms the native cover before the setting renders", async () => {
  jest
    .spyOn(LocalAuthentication, "getEnrolledLevelAsync")
    .mockResolvedValue(LocalAuthentication.SecurityLevel.SECRET);
  jest
    .spyOn(LocalAuthentication, "authenticateAsync")
    .mockResolvedValue({ success: true });
  const transitions: string[] = [];
  mockSetSnapshotCover.mockImplementation((enabled) => {
    if (enabled) transitions.push("cover armed");
  });

  function DeviceSettingsWithObserver() {
    const appLock = usePhoneSettings((settings) => settings.appLock);
    useLayoutEffect(() => {
      if (appLock) transitions.push("setting enabled");
    }, [appLock]);
    return <DeviceSettings />;
  }

  await renderWithProviders(
    <AppLockGate>
      <DeviceSettingsWithObserver />
    </AppLockGate>
  );
  const appLock = screen.getByRole("switch", { name: "App Lock" });
  await waitFor(() => expect(appLock).toBeEnabled());
  await fireEvent(appLock, "valueChange", true);
  expect(appLock).toBeChecked();
  expect(transitions.slice(0, 2)).toEqual(["cover armed", "setting enabled"]);
});
