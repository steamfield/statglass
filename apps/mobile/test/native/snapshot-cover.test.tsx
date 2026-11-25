import { beforeEach, expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { FakeNative, installNative } from "@test/transport/fake-native";
import {
  fireEvent,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react-native";
import * as LocalAuthentication from "expo-local-authentication";
import DeviceSettings from "@/app/settings/device";
import { usePhoneSettings } from "@/data/phone-settings";
import { AppLockGate } from "@/lock/app-lock-gate";
import { useSnapshotCover } from "@/lock/snapshot-cover";

let native: FakeNative;

beforeEach(() => {
  native = new FakeNative();
  installNative(native);
});

test("forwards the initial flag and one update per change", async () => {
  const { rerender } = await renderHook(useSnapshotCover, {
    initialProps: true,
  });
  expect(native.setSnapshotCover.mock.calls).toEqual([[true]]);

  await rerender(false);
  await rerender(false);
  expect(native.setSnapshotCover.mock.calls).toEqual([[true], [false]]);
});

test("can mount and update without a native module", async () => {
  installNative(null);
  const { rerender } = await renderHook(useSnapshotCover, {
    initialProps: true,
  });
  await rerender(false);
  expect(native.setSnapshotCover).not.toHaveBeenCalled();
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
    expect(native.setSnapshotCover.mock.calls).toEqual([[appLock]]);
  }
);

test("enabling App Lock arms the native cover before publishing the setting", async () => {
  jest
    .spyOn(LocalAuthentication, "getEnrolledLevelAsync")
    .mockResolvedValue(LocalAuthentication.SecurityLevel.SECRET);
  jest
    .spyOn(LocalAuthentication, "authenticateAsync")
    .mockResolvedValue({ success: true });
  let setting: boolean | undefined;
  const settingWhenArmed: (boolean | undefined)[] = [];
  native.setSnapshotCover.mockImplementation((enabled) => {
    if (enabled) settingWhenArmed.push(setting);
  });

  function DeviceSettingsWithObserver() {
    // The subscription reads synchronously when the setting changes, before React commits.
    usePhoneSettings((settings) => {
      setting = settings.appLock;
      return settings.appLock;
    });
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
  expect(settingWhenArmed[0]).toBe(false);
});
