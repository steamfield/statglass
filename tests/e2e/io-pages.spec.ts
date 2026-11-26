import { expect, type Page, test } from "@playwright/test";
import { chartsReady } from "./helpers/charts-ready";

/**
 * Network, Disk, Battery and Processes pages on the mock transport, in both
 * themes. Screenshots land in test-results/screens/ for the visual
 * review (verification.md); they are not compared against a baseline.
 */
const THEMES = ["light", "dark"] as const;

const PAGES = [
  { route: "/dashboard/network", heading: "Network", slug: "network" },
  { route: "/dashboard/disk", heading: "Disk", slug: "disk" },
  { route: "/dashboard/battery", heading: "Battery", slug: "battery" },
  { route: "/dashboard/processes", heading: "Processes", slug: "processes" },
] as const;

function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

for (const theme of THEMES) {
  for (const p of PAGES) {
    test(`${p.slug} page (${theme}) renders without console errors`, async ({
      page,
    }, info) => {
      const errors = trackConsoleErrors(page);
      await page.setViewportSize({ width: 1280, height: 1000 });
      await page.goto(
        `/?window=dashboard&route=${p.route}&theme=${theme}&ticks=0`
      );
      await expect(
        page.getByRole("heading", { name: p.heading, exact: true })
      ).toBeVisible();
      await chartsReady(page);
      await page.screenshot({
        animations: "disabled",
        path: `test-results/screens/${p.slug}-${theme}-${info.project.name}.png`,
        fullPage: true,
      });
      expect(errors).toEqual([]);
    });
  }
}

for (const p of [
  {
    route: "/dashboard/network",
    chart: /^Network: upload above the line/,
    row: "Upload",
  },
  { route: "/dashboard/disk", chart: /^Disk I\/O: read above/, row: "Read" },
]) {
  test(`hovering a ${p.route} bar shows its values`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto(`/?window=dashboard&route=${p.route}&ticks=0`);
    const chart = page.getByRole("img", { name: p.chart });
    await chart.waitFor();
    await chartsReady(page);
    const box = await chart.boundingBox();
    if (!box) throw new Error("chart not laid out");
    await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2);
    const tip = page.getByRole("tooltip");
    await expect(tip).toBeVisible();
    await expect(tip).toContainText(p.row);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height + 200);
    await expect(tip).toHaveCount(0);
  });
}

test("quitting an app asks first, then keeps its group while a helper runs", async ({
  page,
}) => {
  // A quit process leaves the table on the engine's next sample, so the test
  // owns the clock: paused while it quits, then one 1 s tick (the full table
  // asks for every sample) brings the batch without the main.
  await page.clock.install();
  await page.goto("/?window=dashboard&route=/dashboard/processes");
  const table = page.getByRole("table", { name: "Processes", exact: true });
  // Xcode's group holds its main (2214) and SourceKitService (2240).
  const xcode = table.locator('tr[data-name="Xcode"]').first();
  await expect(xcode).toContainText("2 processes");
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  await xcode.hover();
  await xcode
    .getByRole("button", { name: "Quit Xcode (2214)", exact: true })
    .click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Quit Xcode?");
  await dialog.getByRole("button", { name: "Quit", exact: true }).click();
  await page.clock.runFor(1000);
  await expect(page.getByText("Asked Xcode (2214) to quit")).toBeVisible();
  // The main is gone; the group stays and now reads as its one helper.
  await expect(
    xcode.getByRole("checkbox", { name: "Select SourceKitService (2240)" })
  ).toBeVisible();
  await expect(xcode).toContainText("SourceKitService");
  await expect(xcode).not.toContainText("processes");
});

test("battery page on a desktop goes back to Overview", async ({ page }) => {
  await page.goto(
    "/?window=dashboard&route=/dashboard/battery&ticks=0&scenario=no-battery"
  );
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true })
  ).toBeVisible();
});
