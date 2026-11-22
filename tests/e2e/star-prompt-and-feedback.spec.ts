import { expect, test } from "@playwright/test";

const VIEWPORT = { width: 1280, height: 900 };
const CALM_DELAY_ADVANCE_MS = 10_000;

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: dashboard shows floating star prompt after calm delay and dismisses on star`, async ({
    page,
  }) => {
    await page.clock.install();
    await page.setViewportSize(VIEWPORT);
    await page.goto(
      `/?window=dashboard&route=/dashboard/overview&scenario=star-prompt&theme=${theme}&ticks=0`
    );
    await expect(
      page.getByRole("heading", { name: "Overview", exact: true })
    ).toBeVisible();

    await page.clock.fastForward(CALM_DELAY_ADVANCE_MS);

    const card = page.getByRole("status", {
      name: /star statglass on github/i,
    });
    await expect(card).toBeVisible({ timeout: 12_000 });
    await expect(card).toContainText("Enjoying StatGlass?");
    await expect(
      card.getByRole("button", { name: "Star on GitHub" })
    ).toBeVisible();
    await expect(card.getByRole("button", { name: "Not now" })).toBeVisible();

    await card.getByRole("button", { name: "Star on GitHub" }).click();
    await expect(card).toBeHidden();

    // Another calm-moment delay must not bring it back.
    await page.clock.fastForward(CALM_DELAY_ADVANCE_MS);
    await expect(card).toHaveCount(0);
  });

  test(`${theme}: popover never shows the GitHub star prompt`, async ({
    page,
  }) => {
    await page.clock.install();
    await page.setViewportSize(VIEWPORT);
    await page.goto(
      `/?window=popover&route=/popover&scenario=star-prompt&theme=${theme}&ticks=0`
    );
    await expect(
      page.getByRole("button", { name: /open dashboard/i })
    ).toBeVisible();

    await page.clock.fastForward(CALM_DELAY_ADVANCE_MS);

    await expect(
      page.getByRole("status", { name: /star statglass on github/i })
    ).toHaveCount(0);
  });

  test(`${theme}: settings shows feedback and support rows and sidebar feedback button`, async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORT);
    await page.goto(
      `/?window=dashboard&route=/dashboard/settings&theme=${theme}&ticks=0`
    );
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true })
    ).toBeVisible();

    await expect(
      page.getByText("Feedback & issues", { exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Copy system info" })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "File feedback" })
    ).toBeVisible();

    await expect(
      page.getByText("Support StatGlass", { exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Star on GitHub" })
    ).toBeVisible();

    // Vitest asserts the open_url call; here the click must not surface an error.
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Feedback" })
      .click();
    await expect(page.getByText("Couldn't open link.")).toHaveCount(0);
  });
}
