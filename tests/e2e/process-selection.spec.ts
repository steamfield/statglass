import { expect, type Locator, type Page, test } from "@playwright/test";

/** An app's group row on the Processes table (its members stay collapsed). */
const groupRow = (table: Locator, app: string) =>
  table.locator(`tr[data-name="${app}"]`).first();

/** The selection bar's count, once it shows one. */
async function selectedCount(page: Page): Promise<number> {
  const bar = page.getByText(/^\d+ selected$/);
  await expect(bar).toBeVisible();
  return Number.parseInt((await bar.textContent()) ?? "", 10);
}

for (const theme of ["dark", "light"] as const) {
  test(`bulk selection, hidden review and confirmation (${theme})`, async ({
    page,
  }, info) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(
      `/?window=dashboard&route=/dashboard/processes&theme=${theme}&ticks=0`
    );
    // Xcode is a group (its main and SourceKitService) that selects its main;
    // Figma is a group of one that reads as its process.
    const table = page.getByRole("table", { name: "Processes", exact: true });
    await groupRow(table, "Xcode").click();
    await groupRow(table, "Figma").click({ modifiers: ["Meta"] });
    await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
    await page.getByRole("searchbox").fill("node");
    await expect(page.getByText("2 selected · 2 hidden")).toBeVisible();
    await page
      .getByRole("button", { name: "Selected only", exact: true })
      .click();
    await expect(
      page.getByRole("table", { name: "Selected processes" }).getByRole("row")
    ).toHaveCount(3);
    await page.screenshot({
      path: `test-results/screens/process-selection-${theme}-${info.project.name}.png`,
    });
    await page
      .getByRole("button", { name: "Force Quit 2…", exact: true })
      .click();
    const dialog = page.getByRole("alertdialog", {
      name: "Force quit 2 processes?",
    });
    await expect(dialog).toContainText("Xcode");
    await expect(dialog).toContainText("Figma");
    await page.screenshot({
      path: `test-results/screens/process-batch-confirm-${theme}-${info.project.name}.png`,
    });
    await dialog
      .getByRole("button", { name: "Force Quit 2 processes", exact: true })
      .click();
    await expect(
      page.getByText("Batch results: 2 of 2 requests accepted")
    ).toBeVisible();
    await page.getByRole("link", { name: /^CPU/ }).click();
    await page.getByRole("link", { name: "Processes", exact: true }).click();
    await expect(page.getByText("2 selected", { exact: true })).toHaveCount(0);
  });
}

test("batch results fit above the footer of a full live table", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?window=dashboard&route=/dashboard/processes&ticks=0");
  await page
    .getByRole("checkbox", { name: "Select Xcode", exact: true })
    .click();
  await page.getByRole("checkbox", { name: "Select Figma (1712)" }).click();
  await page.getByRole("button", { name: "Quit 2…", exact: true }).click();
  await page
    .getByRole("button", { name: "Quit 2 processes", exact: true })
    .click();
  const results = page.getByText("Batch results: 2 of 2 requests accepted");
  await results.click();
  const detail = page.locator("details[open]");
  await expect(detail).toContainText("Asked Xcode");
  const bounds = await detail.boundingBox();
  const footer = await page.locator("footer").last().boundingBox();
  expect(bounds).not.toBeNull();
  expect(footer).not.toBeNull();
  if (bounds && footer)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(footer.y + 1);
});

test("native selection modifiers, virtual keyboard navigation and gutter dragging", async ({
  page,
}) => {
  await page.goto("/?window=dashboard&route=/dashboard/processes&ticks=0");
  const table = page.getByRole("table", { name: "Processes", exact: true });
  const xcode = groupRow(table, "Xcode");
  const figma = groupRow(table, "Figma");
  await xcode.click();
  await figma.click({ modifiers: ["Shift"] });
  // A range takes every group between the two, each as its quit targets.
  const range = await selectedCount(page);
  expect(range).toBeGreaterThan(2);
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await xcode.focus();
  await page.keyboard.press("Meta+End");
  await expect(table.locator("tr[data-process-key]:focus")).toHaveCount(1);
  await page.keyboard.press("Space");
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await page.keyboard.press("Meta+a");
  // What each app's Quit acts on, so collapsed groups' helpers stay out and
  // nothing selected is hidden; fewer than the 800 processes listed.
  const all = await selectedCount(page);
  expect(all).toBeGreaterThan(range);
  expect(all).toBeLessThan(800);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Home");
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  const start = await xcode.locator("[data-selection-gutter]").boundingBox();
  const end = await figma.boundingBox();
  if (!start || !end) throw new Error("Missing drag rows");
  await page.mouse.move(start.x + 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + 2, end.y + end.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(
    page.getByText(`${range} selected`, { exact: true })
  ).toBeVisible();
  await xcode.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", {
      name: `Quit ${range} processes…`,
      exact: true,
    })
  ).toBeVisible();
});

for (const [route, tableName] of [
  ["cpu", "CPU"],
  ["gpu", "GPU"],
  ["memory", "Memory"],
  ["disk", "Disk"],
  ["power", "Energy"],
] as const) {
  test(`${route} selects an app as its main process and adds members`, async ({
    page,
  }, info) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(
      `/?window=dashboard&route=/dashboard/${route}&theme=dark&ticks=0`
    );
    const table = page.getByRole("table", {
      name: `${tableName} by app`,
      exact: true,
    });
    const groupName = route === "gpu" ? "Safari" : "Xcode";
    const group = table.getByRole("checkbox", {
      name: `Select ${groupName}`,
      exact: true,
    });
    // An app selects as its main process; members are added one by one.
    await group.click();
    await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
    await table
      .getByRole("button", { name: `Show ${groupName} processes` })
      .click();
    const member = /Select .+ \(\d+\)/;
    await expect(
      table.getByRole("checkbox", { name: member, checked: true })
    ).toHaveCount(1);
    await table
      .getByRole("checkbox", { name: member, checked: false })
      .locator(":scope:enabled")
      .first()
      .click();
    await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
    await expect(group).toBeChecked();
    await page.screenshot({
      path: `test-results/screens/process-group-${route}-${info.project.name}.png`,
    });
    await page
      .getByRole("button", { name: /^Force Quit \d+…$/, exact: true })
      .click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });
}
