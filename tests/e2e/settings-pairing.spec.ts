import { expect, type Page, test } from "@playwright/test";

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

for (const theme of ["light", "dark"]) {
  test(`pairs and revokes an iPhone in ${theme} mode`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.clock.install();
    await page.goto(`${settings}&theme=${theme}`);
    await enableMonitoring(page);
    const panel = page.getByRole("region", { name: "Paired devices" });
    await expect(panel.getByText("Home iPhone")).toBeVisible();
    const monitoring = page.getByRole("region", { name: "Remote monitoring" });
    await monitoring.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath("remote-monitoring.png"),
      animations: "disabled",
    });

    const dialog = await openPairing(page);
    await expect(
      dialog.getByRole("img", { name: "Pairing QR code" })
    ).toBeVisible();
    await expect(dialog.getByText("K7M2RX", { exact: true })).toBeVisible();
    await expect(dialog.getByText(/Expires in/)).toBeVisible();
    await page.screenshot({
      path: info.outputPath("pairing-qr.png"),
      animations: "disabled",
    });

    await page.clock.runFor(4000);
    await expect(
      dialog.getByText("Travel iPhone", { exact: true })
    ).toBeVisible();
    await expect(dialog.getByText("iPhone 16", { exact: true })).toBeVisible();
    await expect(
      dialog.getByText("Scan in StatGlass on your iPhone.")
    ).toBeHidden();
    await expect(dialog.getByText("K7M2RX", { exact: true })).toBeVisible();
    await page.screenshot({
      path: info.outputPath("pairing-pending.png"),
      animations: "disabled",
    });

    await page.clock.resume();
    await dialog.getByRole("button", { name: "Approve" }).click();
    await expect(dialog.getByText("iPhone paired.")).toBeVisible();
    await expect(
      dialog.getByText("Scan in StatGlass on your iPhone.")
    ).toBeHidden();
    await page.screenshot({
      path: info.outputPath("pairing-approved.png"),
      animations: "disabled",
    });
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(panel.getByText("Travel iPhone")).toBeVisible();
    await panel.getByRole("button", { name: "Revoke Travel iPhone" }).click();
    const confirmation = page.getByRole("alertdialog", {
      name: "Revoke Travel iPhone?",
    });
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(panel.getByText("Travel iPhone")).toBeVisible();
    await panel.getByRole("button", { name: "Revoke Travel iPhone" }).click();
    await page.screenshot({
      path: info.outputPath("revoke-confirm.png"),
      animations: "disabled",
    });
    await confirmation.getByRole("button", { name: "Revoke access" }).click();
    await expect(panel.getByText("Travel iPhone")).toBeHidden();
    await panel.getByRole("button", { name: "Revoke Home iPhone" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Revoke access" })
      .click();
    await expect(panel.getByText("No paired devices.")).toBeVisible();
  });
}

test("shows preflight guidance, denies and expires an offer without leaving approval available", async ({
  page,
}, info) => {
  await page.clock.install();
  await page.goto(settings);
  const dialog = await openPairing(page);
  await expect(dialog.getByRole("alert")).toContainText(
    "Turn on Allow remote monitoring"
  );
  await page.screenshot({
    path: info.outputPath("pairing-monitoring-off.png"),
    animations: "disabled",
  });
  await page.clock.resume();
  await page.keyboard.press("Escape");

  await enableMonitoring(page);
  await openPairing(page);
  await expect(dialog.getByRole("img")).toBeVisible();
  await page.clock.runFor(4000);
  await page.clock.resume();
  await dialog.getByRole("button", { name: "Deny" }).click();
  await expect(dialog.getByText("Pairing denied.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Approve" })).toBeHidden();
  await page.keyboard.press("Escape");

  await openPairing(page);
  await expect(dialog.getByRole("img")).toBeVisible();
  await page.clock.runFor(4000);
  await expect(dialog.getByRole("button", { name: "Approve" })).toBeVisible();
  await page.clock.fastForward(600_000);
  await page.clock.runFor(50);
  await expect(dialog.getByText("Pairing expired.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Approve" })).toBeHidden();
});
