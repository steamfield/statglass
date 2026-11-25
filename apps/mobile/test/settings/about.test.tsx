import { expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import {
  BUILD_INFO,
  FakeNative,
  installNative,
} from "@test/transport/fake-native";
import { act, fireEvent, screen, within } from "@testing-library/react-native";
import Constants from "expo-constants";
import { AccessibilityInfo, Linking } from "react-native";
import AboutSettings from "@/app/settings/about";

// Expo exposes this setter to supply the embedded manifest in tests.
const constants = Constants as typeof Constants & {
  __rawManifest_TEST: typeof Constants.expoConfig;
};
const pages = [
  ["Privacy policy", "https://statglass.steamfield.io/docs/iphone#privacy"],
  ["Support", "https://statglass.steamfield.io/docs/iphone#support"],
] as const;

test("shows the app build, installed core version and protocol range", async () => {
  const previous = constants.__rawManifest_TEST;
  constants.__rawManifest_TEST = {
    name: "StatGlass",
    slug: "statglass",
    version: "1.0.0",
    ios: { buildNumber: "123" },
  };
  try {
    installNative(new FakeNative());
    await renderWithProviders(<AboutSettings />);
    expect(screen.getByLabelText("App version")).toHaveAccessibilityValue({
      text: "1.0.0 (123)",
    });
    expect(screen.getByText("1.0.0 (123)")).toBeOnTheScreen();
    expect(
      within(screen.getByLabelText("Core")).getByText(BUILD_INFO.version)
    ).toBeOnTheScreen();
    expect(
      within(screen.getByLabelText("Protocol")).getByText("3 to 5")
    ).toBeOnTheScreen();
  } finally {
    constants.__rawManifest_TEST = previous;
  }
});

test.each(pages)("opens %s from a link row", async (name, url) => {
  const open = jest
    .spyOn(Linking, "openURL")
    .mockClear()
    .mockResolvedValue(undefined);
  await renderWithProviders(<AboutSettings />);
  await fireEvent.press(screen.getByRole("link", { name }));
  expect(open).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledWith(url);
});

test.each(pages)(
  "shows and announces a failed %s link and clears the error on retry",
  async (name, url) => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const announce = jest
      .spyOn(AccessibilityInfo, "announceForAccessibility")
      .mockClear()
      .mockImplementation(() => undefined);
    jest
      .spyOn(Linking, "openURL")
      .mockReset()
      .mockRejectedValueOnce(new Error("No browser is available."))
      .mockResolvedValueOnce(undefined);
    await renderWithProviders(<AboutSettings />);
    const link = screen.getByRole("link", { name });
    await fireEvent.press(link);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      `Couldn't open the page\n${url}`
    );
    expect(announce).toHaveBeenCalledWith("Couldn't open the page");
    await fireEvent.press(link);
    expect(screen.queryByRole("alert")).toBeNull();
  }
);

test("an earlier link's failure does not override a later successful tap", async () => {
  const earlier = Promise.withResolvers<void>();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest
    .spyOn(Linking, "openURL")
    .mockReset()
    .mockReturnValueOnce(earlier.promise)
    .mockResolvedValueOnce(undefined);
  await renderWithProviders(<AboutSettings />);
  await fireEvent.press(screen.getByRole("link", { name: "Privacy policy" }));
  await fireEvent.press(screen.getByRole("link", { name: "Support" }));
  await act(() => earlier.reject(new Error("The request was cancelled.")));
  expect(screen.queryByRole("alert")).toBeNull();
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

test("opens the StatGlass licenses from About", async () => {
  const open = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
  await renderWithProviders(<AboutSettings />);
  await fireEvent.press(screen.getByRole("button", { name: "Licenses" }));
  expect(open).toHaveBeenCalledWith(
    "https://github.com/steamfield/statglass/blob/main/LICENSE"
  );
});

test("shows the reason when iOS cannot open the licenses", async () => {
  jest
    .spyOn(Linking, "openURL")
    .mockRejectedValue(new Error("No browser is available."));
  await renderWithProviders(<AboutSettings />);
  await fireEvent.press(screen.getByRole("button", { name: "Licenses" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "No browser is available."
  );
});
