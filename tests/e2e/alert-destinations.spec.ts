/**
 * The Alerts page's "Send to" panel (plan/rfc-alerts.md section 5) on the
 * mock transport, in both themes: add an ntfy destination with a generated
 * topic, send it a test and read "Delivered"; with `alert-delivery-fails`,
 * read the failure instead. The clock is fixed, so a delivery reads 22:40.
 * Screenshots land in test-results/screens/ for the visual review.
 */
import { expect, type Page, test } from "@playwright/test";

const THEMES = ["light", "dark"] as const;
const FIXED_NOW = new Date(2026, 9, 4, 22, 40);
const NAME = "Phone";

function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

async function openAlerts(page: Page, theme: string, scenario: string) {
  await page.clock.setFixedTime(FIXED_NOW);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(
    `/?window=dashboard&route=/dashboard/alerts&scenario=${scenario}&theme=${theme}&ticks=0`
  );
  await expect(
    page.getByRole("heading", { name: "Alerts", exact: true })
  ).toBeVisible();
}

const sendToRegion = (page: Page) =>
  page.getByRole("region", { name: "Send to", exact: true });

/** Adds an ntfy destination named `NAME` on a generated topic. */
async function addPhone(page: Page) {
  await sendToRegion(page)
    .getByRole("button", { name: "Add destination", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Add destination" });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(NAME);
  await dialog.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(
    dialog.getByRole("textbox", { name: "Topic", exact: true })
  ).toHaveValue(/^statglass-[a-z2-7]{20}$/);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
}

for (const theme of THEMES) {
  test.describe(`alert destinations (${theme})`, () => {
    test("an ntfy destination is added and a test is delivered", async ({
      page,
    }, info) => {
      const errors = trackConsoleErrors(page);
      await openAlerts(page, theme, "alerts");
      await addPhone(page);
      const region = sendToRegion(page);
      await expect(
        region.getByRole("switch", { name: NAME, exact: true })
      ).toBeChecked();
      await expect(region).toContainText("ntfy · ntfy.sh/stat…");
      await region
        .getByRole("button", { name: `Send test to ${NAME}`, exact: true })
        .click();
      await expect(region).toContainText("Delivered 22:40");
      await region.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `test-results/screens/alert-destinations-${theme}-${info.project.name}.png`,
        fullPage: true,
        animations: "disabled",
      });
      expect(errors).toEqual([]);
    });

    test("a failed test shows why", async ({ page }) => {
      const errors = trackConsoleErrors(page);
      await openAlerts(page, theme, "alerts,alert-delivery-fails");
      await addPhone(page);
      const region = sendToRegion(page);
      await region
        .getByRole("button", { name: `Send test to ${NAME}`, exact: true })
        .click();
      await expect(region).toContainText("Failed 22:40 · HTTP 403");
      expect(errors).toEqual([]);
    });
  });
}
