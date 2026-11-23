import { expect, test } from "@playwright/test";

/**
 * The grouped app tables scroll inside their card on a narrow window: no
 * part of a table, its sr-only header labels included, widens the card or
 * the page.
 */
const PAGES = [
  { route: "/dashboard/cpu", table: "CPU by app" },
  { route: "/dashboard/network", table: "Network by app" },
] as const;

for (const p of PAGES) {
  test(`${p.table} fits a 360 px window`, async ({ page }, info) => {
    await page.setViewportSize({ width: 360, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/?window=dashboard&route=${p.route}&theme=dark&ticks=0`);
    const table = page.getByRole("table", { name: p.table });
    await expect(table.getByRole("row").nth(1)).toBeVisible();
    await expect
      .poll(() =>
        table.evaluate((el) => {
          const card = el.closest("section");
          if (!card) throw new Error("An app table sits in a section card");
          return {
            pageOverflow: Math.max(
              0,
              document.documentElement.scrollWidth - window.innerWidth
            ),
            cardOverflow: Math.max(0, card.scrollWidth - card.clientWidth),
          };
        })
      )
      .toEqual({ pageOverflow: 0, cardOverflow: 0 });
    await table.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `test-results/screens/app-table-360-${p.route.split("/").pop()}-${info.project.name}.png`,
    });
  });
}
