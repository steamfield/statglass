import { expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { FakeNative, ok } from "@test/transport/fake-native";
import { fireEvent, screen } from "@testing-library/react-native";
import { Clipboard } from "react-native";
import DeviceSettings from "@/app/settings/device";
import { createNativeTransport } from "@/transport";

const KEY = "ecdsa-sha2-nistp256 test-key statglass-mobile";

test("This iPhone explains when the key is unavailable", async () => {
  await renderWithProviders(<DeviceSettings />);
  expect(screen.getByText("Available after pairing")).toBeOnTheScreen();
  expect(screen.getByRole("switch", { name: "App Lock" })).toBeOnTheScreen();
});

test("copies the phone’s key with App Lock still present", async () => {
  const native = new FakeNative();
  native.call.mockResolvedValueOnce(ok(KEY));
  const copy = jest
    .spyOn(Clipboard, "setString")
    .mockImplementation(() => undefined);
  await renderWithProviders(<DeviceSettings />, {
    transport: createNativeTransport(native),
  });
  expect(await screen.findByText(KEY)).toBeOnTheScreen();
  expect(screen.getByRole("switch", { name: "App Lock" })).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole("button", { name: "Copy" }));
  expect(copy).toHaveBeenCalledWith(KEY);
  expect(screen.getByRole("button", { name: "Copied" })).toBeOnTheScreen();
});

test("shows a temporary key failure and lets the user retry without leaving This iPhone", async () => {
  const native = new FakeNative();
  native.call.mockRejectedValueOnce(new Error("Keychain is locked."));
  native.call.mockResolvedValueOnce(ok(KEY));
  await renderWithProviders(<DeviceSettings />, {
    transport: createNativeTransport(native),
  });
  expect(await screen.findByText(/Keychain is locked/)).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText(KEY)).toBeOnTheScreen();
});

test("explains a clipboard failure and leaves Copy available", async () => {
  const native = new FakeNative();
  native.call.mockResolvedValueOnce(ok(KEY));
  jest.spyOn(Clipboard, "setString").mockImplementation(() => {
    throw new Error("Clipboard is unavailable.");
  });
  await renderWithProviders(<DeviceSettings />, {
    transport: createNativeTransport(native),
  });
  await fireEvent.press(await screen.findByRole("button", { name: "Copy" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Clipboard is unavailable."
  );
  expect(screen.getByRole("button", { name: "Copy" })).toBeOnTheScreen();
});
