import { expect, type Page, test } from "@playwright/test";

async function openRemoteAlerts(page: Page, scenario: string) {
  await page.goto(`/?route=/dashboard/overview&scenario=${scenario}&ticks=0`);
  await page.getByRole("combobox", { name: "Selected machine" }).click();
  await page.getByRole("option", { name: "linux-tailscale" }).click();
  await page.getByRole("link", { name: "Alerts" }).click();
  await expect(
    page.getByRole("heading", { name: "Alerts on linux-tailscale" })
  ).toBeVisible();
}

async function draftRule(page: Page) {
  await page.getByRole("button", { name: "New rule" }).click();
  const dialog = page.getByRole("dialog", { name: "New rule" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("Linux CPU watch");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  return dialog;
}

test("adds a rule to the selected Linux host", async ({ page }) => {
  await openRemoteAlerts(page, "linux-host");
  const dialog = await draftRule(page);
  await expect(dialog).toBeHidden();
  const rules = page.getByRole("region", { name: "Rules" });
  await expect(
    rules.getByRole("switch", { name: "Linux CPU watch" })
  ).toBeChecked();
  await expect(rules.getByText("Made by a newer version")).toBeVisible();
});

test("shows the stale revision message and reloads the host’s rules", async ({
  page,
}) => {
  await openRemoteAlerts(page, "linux-alerts-stale");
  const dialog = await draftRule(page);
  await expect(dialog.getByRole("alert")).toHaveText(
    "The rules on linux-tailscale changed. Reload them and try again."
  );
  await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue(
    "Linux CPU watch"
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(
    page.getByRole("switch", { name: "CPU saturation" })
  ).toBeChecked();
  await expect(
    page.getByRole("switch", { name: "Linux CPU watch" })
  ).toHaveCount(0);
});
