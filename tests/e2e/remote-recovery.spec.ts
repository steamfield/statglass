import { expect, test } from "@playwright/test";
import { abortGiphyMedia, mockGiphyMedia } from "./helpers/mock-giphy";

for (const theme of ["light", "dark"]) {
  test(`a never-connected host keeps navigation and recovery actions (${theme})`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await mockGiphyMedia(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 833 });
    await page.goto(
      `/?route=/dashboard/hosts&scenario=host-unreachable&theme=${theme}&ticks=0`
    );
    const row = page.getByRole("region", { name: "unreachable", exact: true });
    await row
      .getByRole("button", { name: "View metrics", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Overview", exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Can’t connect to unreachable" })
    ).toBeVisible();
    await expect(page.getByRole("navigation")).toBeVisible();
    await expect(
      page.getByText("Offline", { exact: true }).first()
    ).toBeVisible();
    await expect(
      page.getByText("Sampling every 0s", { exact: true })
    ).toHaveCount(0);
    await page.screenshot({
      path: `test-results/screens/remote-unreachable-${theme}-${info.project.name}.png`,
    });
    await page.getByText("Technical details", { exact: true }).click();
    await expect(page.getByText(/SSH command failed \(127\)/)).toBeVisible();
    await page
      .getByRole("button", { name: "Retry connection", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Retry connection", exact: true })
    ).toBeEnabled();
    await page
      .getByRole("navigation")
      .getByRole("link", { name: /^CPU/ })
      .click();
    await expect(
      page.getByRole("heading", { name: "CPU", exact: true })
    ).toBeVisible();
    await expect(
      page.getByText("This view hit a snag", { exact: true })
    ).toHaveCount(0);
    await page.screenshot({
      path: `test-results/screens/remote-empty-cpu-${theme}-${info.project.name}.png`,
    });
    await page.getByRole("link", { name: "Open Hosts", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Hosts", exact: true })
    ).toBeVisible();
    expect(errors).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true);
  });

  test(`an offline host with mirrored history shows banner below header and keeps history usable (${theme})`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await mockGiphyMedia(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 833 });
    await page.goto(
      `/?route=/dashboard/hosts&scenario=host-offline-history&theme=${theme}&ticks=0`
    );
    const card = page.getByRole("region", { name: "M4 Mini", exact: true });
    await card
      .getByRole("button", { name: "View metrics", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Overview", exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Can’t connect to M4 Mini" })
    ).toBeVisible();
    await page
      .getByRole("navigation")
      .getByRole("link", { name: /^Memory/ })
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Memory", exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Can’t connect to M4 Mini" })
    ).toBeVisible();
    await expect(
      page.getByText("m4-mini.local", { exact: true })
    ).toBeVisible();
    await expect(page.getByText("m4-mini-ts", { exact: true })).toBeVisible();
    await page.screenshot({
      path: `test-results/screens/remote-offline-history-memory-${theme}-${info.project.name}.png`,
    });
    await page
      .getByRole("button", { name: "Jump to saved history", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Timeline", exact: true })
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Switch to This Mac", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Can’t connect to M4 Mini" })
    ).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true);
  });
}

test("falls back cleanly to a semantic icon when Giphy media is unreachable offline", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await abortGiphyMedia(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 833 });
  await page.goto(
    "/?route=/dashboard/hosts&scenario=host-offline-history&theme=dark&ticks=0"
  );
  const card = page.getByRole("region", { name: "M4 Mini", exact: true });
  await card.getByRole("button", { name: "View metrics", exact: true }).click();
  await page
    .getByRole("navigation")
    .getByRole("link", { name: /^Memory/ })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Memory", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Can’t connect to M4 Mini" })
  ).toBeVisible();
  await expect(page.getByTestId("error-media-fallback")).toBeVisible();
  await page.screenshot({
    path: `test-results/screens/remote-offline-history-fallback-dark-${info.project.name}.png`,
  });
  expect(errors).toEqual([]);
});
