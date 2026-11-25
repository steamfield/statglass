import type { PairingPreview } from "@core/generated/types";
import { expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { fireEvent, screen } from "@testing-library/react-native";
import { PermissionStatus } from "expo";
import { Camera, CameraView } from "expo-camera";
import * as Device from "expo-device";
import { Linking } from "react-native";
import { PairingProvider } from "@/data/pairing-context";
import type { PhonePairing } from "@/data/pairing-seam";
import { PairingFlow } from "@/pairing";

const granted = {
  status: PermissionStatus.GRANTED,
  granted: true,
  canAskAgain: true,
  expires: "never",
} as const;
const denied = {
  status: PermissionStatus.DENIED,
  granted: false,
  canAskAgain: false,
  expires: "never",
} as const;
const undetermined = {
  ...denied,
  status: PermissionStatus.UNDETERMINED,
  canAskAgain: true,
} as const;

async function openScanner() {
  const pairing = {
    previewPairing: jest.fn<PhonePairing["previewPairing"]>(async () => ({
      status: "ok",
      data: {
        host_id: "builder",
        name: "Build host",
        os: "Linux",
        user: "statglass",
        targets: [],
        code: "ABC123",
        expires_ms: Date.now() + 60_000,
        can_hand_over: false,
      } satisfies PairingPreview,
    })),
    pair: jest.fn<PhonePairing["pair"]>(),
  };
  await renderWithProviders(
    <PairingProvider pairing={pairing}>
      <PairingFlow onPaired={jest.fn()} onDone={jest.fn()} />
    </PairingProvider>
  );
  await fireEvent.press(screen.getByRole("button", { name: "Scan QR" }));
  return pairing;
}

test("shows Paste when the device has no camera and skips the permission prompt", async () => {
  jest.replaceProperty(Device, "isDevice", false);
  const check = jest
    .spyOn(Camera, "getCameraPermissionsAsync")
    .mockResolvedValue(undetermined);
  const request = jest.spyOn(Camera, "requestCameraPermissionsAsync");
  await openScanner();
  expect(
    screen.getByRole("header", { name: "Camera is unavailable" })
  ).toBeOnTheScreen();
  expect(request).not.toHaveBeenCalled();
  expect(check).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole("button", { name: "Paste code" }));
  expect(screen.getByLabelText("Pairing code")).toBeOnTheScreen();
});

test("primes once, asks for permission and accepts the first pairing QR", async () => {
  jest.replaceProperty(Device, "isDevice", true);
  jest
    .spyOn(Camera, "getCameraPermissionsAsync")
    .mockResolvedValue(undetermined);
  const request = jest
    .spyOn(Camera, "requestCameraPermissionsAsync")
    .mockResolvedValue(granted);
  jest
    .spyOn(CameraView.prototype, "getAvailableLensesAsync")
    .mockResolvedValue([{ deviceType: "wide", localizedName: "Wide" }]);
  const pairing = await openScanner();
  expect(
    screen.getByRole("header", { name: "Scan a pairing code" })
  ).toBeOnTheScreen();
  expect(request).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole("button", { name: "Continue" }));
  expect(request).toHaveBeenCalledTimes(1);

  const scanner = screen.getByLabelText("Pairing QR scanner");
  await fireEvent(scanner, "barcodeScanned", {
    nativeEvent: { type: "qr", data: "https://example.org" },
  });
  expect(pairing.previewPairing).not.toHaveBeenCalled();
  await fireEvent(scanner, "barcodeScanned", {
    nativeEvent: { type: "qr", data: "SGP1:offer" },
  });
  expect(pairing.previewPairing).toHaveBeenCalledTimes(1);
  expect(pairing.previewPairing).toHaveBeenCalledWith("SGP1:offer");
  expect(
    await screen.findByRole("header", { name: "Build host" })
  ).toBeOnTheScreen();
  expect(screen.queryByLabelText("Pairing QR scanner")).toBeNull();
});

test("shows Paste on a physical device with permission and no available camera lens", async () => {
  jest.replaceProperty(Device, "isDevice", true);
  jest.spyOn(Camera, "getCameraPermissionsAsync").mockResolvedValue(granted);
  jest
    .spyOn(CameraView.prototype, "getAvailableLensesAsync")
    .mockResolvedValue([]);
  await openScanner();
  expect(
    await screen.findByRole("header", { name: "Camera is unavailable" })
  ).toBeOnTheScreen();
  expect(screen.queryByLabelText("Pairing QR scanner")).toBeNull();
  expect(screen.getByRole("button", { name: "Paste code" })).toBeOnTheScreen();
});

test("offers Settings and Paste when permission is denied", async () => {
  jest.replaceProperty(Device, "isDevice", true);
  jest
    .spyOn(Camera, "getCameraPermissionsAsync")
    .mockResolvedValue(undetermined);
  jest.spyOn(Camera, "requestCameraPermissionsAsync").mockResolvedValue(denied);
  const open = jest.spyOn(Linking, "openSettings").mockResolvedValue();
  await openScanner();
  await fireEvent.press(screen.getByRole("button", { name: "Continue" }));
  expect(
    screen.getByRole("header", { name: "Camera access is off" })
  ).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole("button", { name: "Open Settings" }));
  expect(open).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByRole("button", { name: "Paste code" }));
  expect(screen.getByLabelText("Pairing code")).toBeOnTheScreen();
});
