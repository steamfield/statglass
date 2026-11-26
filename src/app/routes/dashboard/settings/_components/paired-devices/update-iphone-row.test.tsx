import { screen, within } from "@testing-library/react";
import { renderWithProviders } from "@tests/test-utils";
import { PairedDevicesPanel } from "./panel";

it("opens Update iPhone from the iPhones settings", async () => {
  const { user } = renderWithProviders(<PairedDevicesPanel />);
  const panel = within(screen.getByRole("region", { name: "iPhones" }));
  expect(panel.getByText("Host list on iPhone")).toBeVisible();
  await user.click(panel.getByRole("button", { name: "Update iPhone" }));
  expect(
    await screen.findByRole("img", { name: "iPhone update QR code" })
  ).toBeVisible();
  expect(screen.getByRole("dialog", { name: "Update iPhone" })).toBeVisible();
});
