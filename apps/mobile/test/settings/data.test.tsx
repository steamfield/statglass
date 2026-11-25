import { expect, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { fireEvent, screen } from "@testing-library/react-native";
import DataSettings from "@/app/settings/data";
import { createPhoneSettingsStore } from "@/data/phone-settings";

test("Data has one cellular switch and explains the slower updates when it is off", async () => {
  await renderWithProviders(<DataSettings />);
  expect(screen.getAllByRole("switch")).toHaveLength(1);
  const live = () =>
    screen.getByRole("switch", { name: "Live updates on cellular" });
  expect(live()).toBeChecked();
  expect(
    screen.getByText(/updates every 5 seconds on cellular/)
  ).toBeOnTheScreen();
  await fireEvent(live(), "valueChange", false);
  expect(live()).not.toBeChecked();
});

test("loading settings drops the old sync preference and keeps the live preference", async () => {
  const settings = { liveOnCellular: false, syncOnCellular: true };
  expect(createPhoneSettingsStore(settings).getState()).not.toHaveProperty(
    "syncOnCellular"
  );
  await renderWithProviders(<DataSettings />, { settings });
  expect(
    screen.getByRole("switch", { name: "Live updates on cellular" })
  ).not.toBeChecked();
});
