import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";

const settings = "/?window=dashboard&route=/dashboard/settings";

async function screenshotThemes(
  page: Page,
  locator: Locator,
  info: TestInfo,
  name: string
) {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.classList.contains("dark"))
      )
      .toBe(colorScheme === "dark");
    await locator.screenshot({
      path: info.outputPath(`${name}-${colorScheme}.png`),
      animations: "disabled",
    });
  }
}

test("shows pending device updates and a fresh iPhone update sheet", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.clock.install();
  await page.goto(settings);
  const panel = page.getByRole("region", { name: "Paired devices" });
  await expect(panel.getByText("Home iPhone", { exact: true })).toBeVisible();
  await expect(panel.getByText("Revoke failed · iPhone A1B2C3")).toBeVisible();
  await expect(panel.getByText("Host is offline.")).toBeVisible();
  await expect(
    panel.getByText("Install pending · iPhone 7F3A2C")
  ).toBeVisible();
  await screenshotThemes(page, panel, info, "paired-devices");

  await panel.getByRole("button", { name: "Retry device updates" }).click();
  await expect(panel.getByText("Install pending · iPhone 7F3A2C")).toBeHidden();
  await expect(panel.getByText("Revoke failed · iPhone A1B2C3")).toBeVisible();

  await panel.getByRole("button", { name: "Update iPhone" }).click();
  const sheet = page.getByRole("dialog", { name: "Update iPhone" });
  await expect(
    sheet.getByRole("img", { name: "iPhone update QR code" })
  ).toBeVisible();
  await expect(sheet.getByText("Lab Mini")).toBeVisible();
  await expect(sheet.getByText("Office server")).toBeVisible();
  await expect(
    sheet.getByText("This host uses an SSH jump host.")
  ).toBeVisible();
  await screenshotThemes(page, sheet, info, "update-iphone");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  await panel.getByRole("button", { name: "Revoke Home iPhone" }).click();
  const revoke = page.getByRole("alertdialog", { name: "Revoke Home iPhone?" });
  await expect(revoke.getByText(/queues removal on the hosts/)).toBeVisible();
  await revoke.getByRole("button", { name: "Revoke access" }).click();
  await expect(panel.getByText("Home iPhone", { exact: true })).toBeHidden();
  await page.clock.fastForward(10000);
  await expect(panel.getByText("Revoke pending · iPhone 7F3A2C")).toHaveCount(
    2
  );
});
