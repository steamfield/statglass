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
import AppearanceSettings from "@/app/settings/appearance";
import Settings from "@/app/settings/index";

const option = (name: string) => screen.getByRole("button", { name });
const routes = getMockContext({
  _layout: () => <Stack />,
  "settings/index": Settings,
  "settings/appearance": AppearanceSettings,
});

test("Appearance marks one choice and remembers it when reopened", async () => {
  const scheme = jest
    .spyOn(Appearance, "setColorScheme")
    .mockImplementation(() => undefined);
  await renderWithProviders(<ExpoRoot context={routes} location="/settings" />);
  await fireEvent.press(
    await screen.findByRole("button", { name: "Appearance" })
  );
  expect(option("System")).toBeSelected();
  expect(option("Light")).not.toBeSelected();
  expect(option("Dark")).not.toBeSelected();

  await fireEvent.press(option("Dark"));
  expect(scheme).toHaveBeenLastCalledWith("dark");
  await act(() => router.back());
  await fireEvent.press(option("Appearance"));
  expect(option("Dark")).toBeSelected();
  expect(option("System")).not.toBeSelected();

  await fireEvent.press(option("Light"));
  expect(scheme).toHaveBeenLastCalledWith("light");
  expect(option("Light")).toBeSelected();
  await fireEvent.press(option("System"));
  expect(scheme).toHaveBeenLastCalledWith("auto");
  expect(option("System")).toBeSelected();
});
