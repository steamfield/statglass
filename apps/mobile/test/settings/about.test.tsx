import { expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import {
  BUILD_INFO,
  FakeNative,
  installNative,
} from "@test/transport/fake-native";
import { screen, within } from "@testing-library/react-native";
import AboutSettings from "@/app/settings/about";

test("shows the installed core's version and protocol range", async () => {
  installNative(new FakeNative());
  await renderWithProviders(<AboutSettings />);
  expect(screen.getByText("App version")).toBeOnTheScreen();
  expect(
    within(screen.getByLabelText("Core")).getByText(BUILD_INFO.version)
  ).toBeOnTheScreen();
  expect(
    within(screen.getByLabelText("Protocol")).getByText("3 to 5")
  ).toBeOnTheScreen();
});

test("marks the core and protocol unavailable without a native module", async () => {
  installNative(null);
  await renderWithProviders(<AboutSettings />);
  expect(
    within(screen.getByLabelText("Core")).getByText("Unavailable")
  ).toBeOnTheScreen();
  expect(
    within(screen.getByLabelText("Protocol")).getByText("Unavailable")
  ).toBeOnTheScreen();
});

test("marks the core and protocol unavailable when native version throws", async () => {
  const native = new FakeNative();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  native.version.mockImplementation(() => {
    throw new Error("The version bridge went away");
  });
  installNative(native);
  await renderWithProviders(<AboutSettings />);
  expect(
    within(screen.getByLabelText("Core")).getByText("Unavailable")
  ).toBeOnTheScreen();
  expect(
    within(screen.getByLabelText("Protocol")).getByText("Unavailable")
  ).toBeOnTheScreen();
});

test("reads the native version once per mount even when About rerenders", async () => {
  const native = new FakeNative();
  installNative(native);
  const view = await renderWithProviders(<AboutSettings />);
  await view.rerender(<AboutSettings />);
  expect(native.version).toHaveBeenCalledTimes(1);
  await view.unmount();
  await renderWithProviders(<AboutSettings />);
  expect(native.version).toHaveBeenCalledTimes(2);
});
