import { expect, type Page } from "@playwright/test";

export async function chartsReady(page: Page) {
  await expect(page.locator("[data-chart-loading]")).toHaveCount(0);
}
