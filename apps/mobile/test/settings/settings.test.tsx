import { createMockTransport } from "@core/mock-transport";
import { expect, jest, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { ExpoRoot, router, Stack } from "expo-router";
import {
  act,
  fireEvent,
  getMockContext,
  screen,
} from "expo-router/testing-library";
import { Appearance } from "react-native";
import SettingsLayout from "@/app/settings/_layout";
import AboutSettings from "@/app/settings/about";
import AppearanceSettings from "@/app/settings/appearance";
import DataSettings from "@/app/settings/data";
import DeviceSettings from "@/app/settings/device";
import HostsSettingsRoute from "@/app/settings/hosts";
import SettingsIndex from "@/app/settings/index";
import { Text } from "@/ui/text";

jest.mock("expo-constants", () => {
  const actual =
    jest.requireActual<typeof import("expo-constants")>("expo-constants");
  return {
    ...actual,
    __esModule: true,
    default: {
      ...actual.default,
      expoConfig: { ...actual.default.expoConfig, version: "1.2.3" },
    },
  };
});

const routes = getMockContext({
  _layout: () => <Stack />,
  index: () => <Text role="title">First launch</Text>,
  "settings/_layout": SettingsLayout,
  "settings/index": SettingsIndex,
  "settings/hosts": HostsSettingsRoute,
  "settings/device": DeviceSettings,
  "settings/data": DataSettings,
  "settings/appearance": AppearanceSettings,
  "settings/about": AboutSettings,
});

test("settings Hosts validates names, reorders and confirms removal locally", async () => {
  const transport = createMockTransport({ scenarios: ["hosts-dashboard"] });
  const original = await transport.listHosts();
  await renderWithProviders(
    <ExpoRoot context={routes} location="/settings" />,
    { transport }
  );
  await fireEvent.press(screen.getByRole("button", { name: "Hosts" }));
  await fireEvent.press(
    await screen.findByRole("button", { name: "Rename studio" })
  );
  const name = screen.getByLabelText("Name on this iPhone");
  const save = screen.getByRole("button", { name: "Save name" });
  await fireEvent.changeText(name, "   ");
  await fireEvent.press(save);
  expect(
    screen.getByRole("alert", { name: /between 1 and 64/ })
  ).toBeOnTheScreen();
  await fireEvent.changeText(name, "x".repeat(65));
  await fireEvent.press(save);
  expect(
    screen.getByRole("alert", { name: /between 1 and 64/ })
  ).toBeOnTheScreen();
  await fireEvent.changeText(name, `   ${"a".repeat(64)}   `);
  await fireEvent.press(save);
  expect(
    await screen.findByRole("button", { name: `Rename ${"a".repeat(64)}` })
  ).toBeOnTheScreen();

  await fireEvent.press(
    screen.getByRole("button", { name: `Move ${"a".repeat(64)} up` })
  );
  const first = screen.getByRole("button", {
    name: `Move ${"a".repeat(64)} up`,
  });
  expect(first).toBeDisabled();
  expect(screen.getAllByRole("button", { name: /^Move .+ up$/ })[0]).toBe(
    first
  );
  await fireEvent.press(
    screen.getByRole("button", { name: `Move ${"a".repeat(64)} down` })
  );
  expect(screen.getAllByRole("button", { name: /^Move .+ up$/ })[0]).not.toBe(
    first
  );

  const remove = `Remove ${"a".repeat(64)}`;
  await fireEvent.press(screen.getByRole("button", { name: remove }));
  expect(screen.getByRole("header", { name: `${remove}?` })).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
  await fireEvent.press(screen.getByRole("button", { name: remove }));
  await fireEvent.press(screen.getByRole("button", { name: "Remove host" }));
  expect(screen.queryByRole("button", { name: remove })).toBeNull();
  expect(await transport.listHosts()).toEqual(original);
});

test("opens each settings section and keeps cellular and appearance choices on return", async () => {
  const setColorScheme = jest
    .spyOn(Appearance, "setColorScheme")
    .mockImplementation(() => undefined);
  await renderWithProviders(<ExpoRoot context={routes} location="/settings" />);

  await fireEvent.press(screen.getByRole("button", { name: "This iPhone" }));
  expect(screen.getByText("Available after pairing")).toBeOnTheScreen();
  await act(() => router.back());

  await fireEvent.press(screen.getByRole("button", { name: "Data" }));
  const live = () =>
    screen.getByRole("switch", { name: "Live updates on cellular" });
  expect(screen.getAllByRole("switch")).toHaveLength(1);
  expect(live()).toBeChecked();
  await fireEvent(live(), "valueChange", false);
  await act(() => router.back());
  await fireEvent.press(screen.getByRole("button", { name: "Data" }));
  expect(live()).not.toBeChecked();
  await act(() => router.back());

  await fireEvent.press(screen.getByRole("button", { name: "Appearance" }));
  expect(screen.getByRole("radio", { name: "System" })).toBeChecked();
  await fireEvent.press(screen.getByRole("radio", { name: "Dark" }));
  expect(setColorScheme).toHaveBeenLastCalledWith("dark");
  await act(() => router.back());
  await fireEvent.press(screen.getByRole("button", { name: "Appearance" }));
  expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
  await fireEvent.press(screen.getByRole("radio", { name: "Light" }));
  expect(setColorScheme).toHaveBeenLastCalledWith("light");
  await fireEvent.press(screen.getByRole("radio", { name: "System" }));
  expect(setColorScheme).toHaveBeenLastCalledWith("auto");
  await act(() => router.back());

  await fireEvent.press(screen.getByRole("button", { name: "About" }));
  expect(screen.getByText("App version")).toBeOnTheScreen();
  expect(screen.getByText("1.2.3")).toBeOnTheScreen();
});

test("redirects a direct host settings link when no transport has been chosen", async () => {
  await renderWithProviders(
    <ExpoRoot context={routes} location="/settings/hosts" />
  );
  expect(
    await screen.findByRole("header", { name: "First launch" })
  ).toBeOnTheScreen();
});
