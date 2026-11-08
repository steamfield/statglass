import { expect, test } from "@playwright/test";

const NOW = new Date(2026, 9, 4, 22, 40);

for (const theme of ["light", "dark"]) {
  test(`${theme}: an Overview event opens Timeline at its absolute range`, async ({
    page,
  }) => {
    await page.clock.setFixedTime(NOW);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(
      `/?window=dashboard&route=/dashboard/overview&theme=${theme}&chart_window=24h&ticks=0`
    );
    await expect(
      page.getByRole("heading", { name: "Overview", exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Time range: 1d", exact: true })
    ).toBeVisible();
    // The mock's ffmpeg alert starts at 19:15 and is detected at 19:20.
    // Its five-minute episode gets one minute of padding on each side.
    await page
      .getByRole("list", { name: "Recent events" })
      .getByRole("button", { name: /Alert · ffmpeg/ })
      .click();
    const heading = page.getByRole("heading", {
      name: "Timeline",
      exact: true,
    });
    await expect(heading).toBeVisible();
    await expect(heading.locator("..")).toContainText(
      "Recorded · 2026-10-04 19:14 to 2026-10-04 19:21"
    );
  });
}
