import { expect, type Page, type TestInfo, test } from "@playwright/test";

const settings = "/?window=dashboard&route=/dashboard/settings";

async function openPairing(page: Page) {
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.getByRole("button", { name: "Pair iPhone" }).click();
  await page.clock.runFor(50);
  return page.getByRole("dialog", { name: "Pair iPhone" });
}

async function enableMonitoring(page: Page) {
  const monitoring = page.getByRole("switch", {
    name: "Allow remote monitoring",
  });
  await monitoring.click();
  await expect(monitoring).toBeChecked();
}

async function screenshotBothThemes(page: Page, info: TestInfo, name: string) {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.classList.contains("dark"))
      )
      .toBe(colorScheme === "dark");
    await page.screenshot({
      path: info.outputPath(`${name}-${colorScheme}.png`),
      animations: "disabled",
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("pairs and revokes an iPhone", async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.clock.install();
  await page.goto(settings);
  const monitoringOff = await openPairing(page);
  await expect(monitoringOff.getByRole("alert")).toContainText(
    "Remote monitoring is off on this host."
  );
  await page.screenshot({
    path: info.outputPath("pairing-monitoring-off.png"),
    animations: "disabled",
  });
  await page.clock.resume();
  await monitoringOff.getByRole("button", { name: "Close" }).click();

  await enableMonitoring(page);
  const panel = page.getByRole("region", { name: "Paired devices" });
  await expect(panel.getByText("Home iPhone")).toBeVisible();
  const monitoring = page.getByRole("region", { name: "Remote monitoring" });
  await monitoring.scrollIntoViewIfNeeded();
  await screenshotBothThemes(page, info, "remote-monitoring");

  const dialog = await openPairing(page);
  await expect(
    dialog.getByRole("img", { name: "Pairing QR code" })
  ).toBeVisible();
  await expect(dialog.getByText("K7M2RX", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Expires in/)).toBeVisible();
  await screenshotBothThemes(page, info, "pairing-qr");

  await page.clock.runFor(4000);
  await expect(
    dialog.getByText("Travel iPhone", { exact: true })
  ).toBeVisible();
  await expect(dialog.getByText("iPhone 16", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText("Scan in StatGlass on your iPhone.")
  ).toBeHidden();
  await expect(dialog.getByText("K7M2RX", { exact: true })).toBeVisible();
  await screenshotBothThemes(page, info, "pairing-pending");

  await page.clock.resume();
  await dialog.getByRole("button", { name: "Approve" }).click();
  await expect(dialog.getByText("iPhone paired.")).toBeVisible();
  await expect(
    dialog.getByText("Scan in StatGlass on your iPhone.")
  ).toBeHidden();
  await screenshotBothThemes(page, info, "pairing-approved");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(panel.getByText("Travel iPhone")).toBeVisible();
  await panel.getByRole("button", { name: "Revoke Travel iPhone" }).click();
  const confirmation = page.getByRole("alertdialog", {
    name: "Revoke Travel iPhone?",
  });
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(panel.getByText("Travel iPhone")).toBeVisible();
  await panel.getByRole("button", { name: "Revoke Travel iPhone" }).click();
  await screenshotBothThemes(page, info, "revoke-confirm");
  await confirmation.getByRole("button", { name: "Revoke access" }).click();
  await expect(panel.getByText("Travel iPhone")).toBeHidden();
  await panel.getByRole("button", { name: "Revoke Home iPhone" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Revoke access" })
    .click();
  await expect(panel.getByText("No paired devices.")).toBeVisible();
});
