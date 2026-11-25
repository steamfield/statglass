import { expect, test } from "@playwright/test";

test("the selected Disk space pill follows its row across the sidebar breakpoint", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?route=/dashboard/disk-space");

  const nav = page.getByRole("navigation", { name: "Dashboard sections" });
  const row = nav.getByRole("link", { name: "Disk space", exact: true });
  const pill = nav.locator("[data-sidebar-pill]");
  await expect(row).toHaveAttribute("aria-current", "page");

  for (const [width, sidebarWidth] of [
    [1280, 220],
    [600, 52],
    [1280, 220],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await expect(nav).toHaveCSS("width", `${sidebarWidth}px`);
    await expect
      .poll(async () => {
        return pill.evaluate((el) => {
          const active = el.parentElement?.querySelector<HTMLElement>(
            "[data-sidebar-item][aria-current]"
          );
          if (!active) return null;
          const translateY = new DOMMatrixReadOnly(
            getComputedStyle(el).transform
          ).m42;
          return translateY - active.offsetTop;
        });
      })
      .toBe(0);
  }
});

test("App Store entry groups also scroll at the minimum window height", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.goto(
    "/?route=/dashboard/settings&scenario=appstore,low-power-mode"
  );

  const nav = page.getByRole("navigation", { name: "Dashboard sections" });
  const settings = nav.getByRole("link", { name: "Settings" });
  const groups = nav.locator("[data-sidebar-pill]").locator("..");
  await expect(nav.getByText("Performance mode · Low Power")).toBeVisible();
  await expect(nav.getByRole("list", { name: "Utilities" })).toHaveCount(0);

  await nav.getByRole("link", { name: "Overview", exact: true }).focus();
  await page.keyboard.press("End");
  await expect(settings).toBeFocused();
  await expect(settings).toBeInViewport({ ratio: 1 });
  await expect
    .poll(() => groups.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await expect(nav.getByRole("button", { name: "Feedback" })).toBeInViewport();
});

test("End scrolls to Disk space while the sidebar chrome stays pinned", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.goto("/?route=/dashboard/disk-space");

  const nav = page.getByRole("navigation", { name: "Dashboard sections" });
  const brand = nav.getByText("StatGlass", { exact: true });
  const dragStrip = nav.locator("[data-tauri-drag-region]").first();
  const host = nav.getByRole("combobox", { name: "Selected machine" });
  const feedback = nav.getByRole("button", { name: "Feedback" });
  const version = nav.getByText(/^v\d+\.\d+/);
  const row = nav.getByRole("link", { name: "Disk space", exact: true });
  const pill = nav.locator("[data-sidebar-pill]");
  const groups = pill.locator("..");
  await expect(row).toHaveAttribute("aria-current", "page");

  await nav.getByRole("link", { name: "Overview", exact: true }).focus();
  await expect.poll(() => groups.evaluate((el) => el.scrollTop)).toBe(0);
  const top = {
    brand: (await brand.boundingBox())?.y,
    dragStrip: (await dragStrip.boundingBox())?.y,
    host: (await host.boundingBox())?.y,
  };

  await page.keyboard.press("End");
  await expect(row).toBeFocused();
  await expect(row).toBeInViewport({ ratio: 1 });
  await expect(pill).toBeInViewport({ ratio: 1 });
  await expect
    .poll(() => groups.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await expect(brand).toBeInViewport({ ratio: 1 });
  await expect(host).toBeInViewport({ ratio: 1 });
  await expect(feedback).toBeInViewport({ ratio: 1 });
  await expect(version).toBeInViewport({ ratio: 1 });
  expect((await brand.boundingBox())?.y).toBe(top.brand);
  expect((await dragStrip.boundingBox())?.y).toBe(top.dragStrip);
  expect((await host.boundingBox())?.y).toBe(top.host);
});
