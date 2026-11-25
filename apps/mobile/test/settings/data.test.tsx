import { expect, test } from "@jest/globals";
import { renderWithProviders } from "@test/render";
import { fireEvent, screen } from "@testing-library/react-native";
import DataSettings from "@/app/settings/data";

test("Data has one cellular switch and explains the slower updates when it is off", async () => {
  await renderWithProviders(<DataSettings />);
  expect(screen.getAllByRole("switch")).toHaveLength(1);
  expect(screen.getAllByLabelText("Live updates on cellular")).toHaveLength(1);
  const live = () =>
    screen.getByRole("switch", { name: "Live updates on cellular" });
  expect(live()).toBeChecked();
  expect(
    screen.getByText(
      "When this is off, the host screen updates every 5 s on cellular."
    )
  ).toBeOnTheScreen();
  await fireEvent(live(), "valueChange", false);
  expect(live()).not.toBeChecked();
});
