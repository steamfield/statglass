/**
 * The Alerts page (plan/rfc-alerts.md section 5) on the mock transport with
 * the `alerts` scenario, in both themes: the built-in switches, a custom
 * rule's whole life (create, edit, switch off, delete) and the Recent list
 * of the two seeded alerts. The clock is fixed at Sun Oct 4, 22:40, so the
 * seeded memory pressure alert reads 21:28 and the ffmpeg alert 19:20.
 * Screenshots land in test-results/screens/ for the visual review.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";

const THEMES = ["light", "dark"] as const;
const FIXED_NOW = new Date(2026, 9, 4, 22, 40);

const HOT_PROCESS_SWITCH = "A process above 200% CPU for 5 minutes";
const THERMAL_SWITCH = "Thermal state Serious or worse";
const RULE_NAME = "Memory watch";

function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

async function openAlerts(page: Page, theme: string) {
  await page.clock.setFixedTime(FIXED_NOW);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(
    `/?window=dashboard&route=/dashboard/alerts&scenario=alerts&theme=${theme}&ticks=0`
  );
  await expect(
    page.getByRole("heading", { name: "Alerts", exact: true })
  ).toBeVisible();
}

const rulesRegion = (page: Page) =>
  page.getByRole("region", { name: "Rules", exact: true });

const recentRegion = (page: Page) =>
  page.getByRole("region", { name: "Recent", exact: true });

const ruleDialog = (page: Page, title: "New rule" | "Edit rule") =>
  page.getByRole("dialog", { name: title });

async function choose(dialog: Locator, field: string, option: string) {
  await dialog.getByRole("combobox", { name: field, exact: true }).click();
  // The select's options render in a portal outside the dialog.
  await dialog
    .page()
    .getByRole("option", { name: option, exact: true })
    .click();
}

/**
 * Leaves the page and comes back, so the remounted switches show the
 * app-wide settings mirror, which takes the `update_settings` result.
 */
async function revisitAlerts(page: Page) {
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true })
  ).toBeVisible();
  await page.getByRole("link", { name: "Alerts", exact: true }).click();
}

for (const theme of THEMES) {
  test.describe(`alerts page (${theme})`, () => {
    test("Recent lists the seeded alerts, newest first", async ({
      page,
    }, info) => {
      const errors = trackConsoleErrors(page);
      await openAlerts(page, theme);
      const items = recentRegion(page).getByRole("listitem");
      await expect(items).toHaveCount(2);
      await expect(items.nth(0)).toContainText("Alert · Memory pressure");
      await expect(items.nth(0)).toContainText("21:28");
      await expect(items.nth(1)).toContainText("Alert · ffmpeg at 251% CPU");
      await expect(items.nth(1)).toContainText("19:20");
      await page.screenshot({
        path: `test-results/screens/alerts-${theme}-${info.project.name}.png`,
        fullPage: true,
        animations: "disabled",
      });
      expect(errors).toEqual([]);
    });

    test("the built-in switches write through update_settings", async ({
      page,
    }) => {
      const errors = trackConsoleErrors(page);
      await openAlerts(page, theme);
      const hot = rulesRegion(page).getByRole("switch", {
        name: HOT_PROCESS_SWITCH,
      });
      const thermal = rulesRegion(page).getByRole("switch", {
        name: THERMAL_SWITCH,
      });
      await expect(hot).not.toBeChecked();
      await expect(thermal).not.toBeChecked();

      await thermal.click();
      await expect(thermal).toBeChecked();
      await revisitAlerts(page);
      await expect(thermal).toBeChecked();
      await expect(hot).not.toBeChecked();

      await hot.click();
      await expect(hot).toBeChecked();
      await thermal.click();
      await expect(thermal).not.toBeChecked();
      await revisitAlerts(page);
      await expect(hot).toBeChecked();
      await expect(thermal).not.toBeChecked();
      expect(errors).toEqual([]);
    });

    test("a custom rule is created, edited, switched off and deleted", async ({
      page,
    }) => {
      const errors = trackConsoleErrors(page);
      await openAlerts(page, theme);
      const rules = rulesRegion(page);
      const ruleSwitch = rules.getByRole("switch", {
        name: RULE_NAME,
        exact: true,
      });

      await page.getByRole("button", { name: "New rule", exact: true }).click();
      const created = ruleDialog(page, "New rule");
      await choose(created, "Metric", "Memory pressure");
      await created
        .getByRole("textbox", { name: "Name", exact: true })
        .fill(RULE_NAME);
      await created.getByRole("button", { name: "Save", exact: true }).click();
      await expect(created).toBeHidden();
      await expect(ruleSwitch).toBeChecked();
      await expect(rules).toContainText("Memory pressure above 80% for 2 min");
      await expect(rules).toContainText("Never fired");

      await rules
        .getByRole("button", { name: `Edit ${RULE_NAME}`, exact: true })
        .click();
      const edited = ruleDialog(page, "Edit rule");
      await edited
        .getByRole("textbox", { name: "Threshold", exact: true })
        .fill("90");
      await edited.getByRole("button", { name: "Save", exact: true }).click();
      await expect(edited).toBeHidden();
      await expect(rules).toContainText("Memory pressure above 90% for 2 min");
      await expect(rules).not.toContainText(
        "Memory pressure above 80% for 2 min"
      );

      await ruleSwitch.click();
      await expect(ruleSwitch).not.toBeChecked();

      await rules
        .getByRole("button", { name: `Edit ${RULE_NAME}`, exact: true })
        .click();
      const deleting = ruleDialog(page, "Edit rule");
      await deleting
        .getByRole("button", { name: "Delete", exact: true })
        .click();
      await expect(deleting).toBeHidden();
      await expect(ruleSwitch).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  });
}
