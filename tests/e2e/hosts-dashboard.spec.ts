import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

async function ready(page: Page) {
  await expect(
    page.getByRole("heading", { name: "Hosts", exact: true })
  ).toBeVisible();
  await expect(page.locator("path[data-line]").first()).not.toHaveAttribute(
    "d",
    ""
  );
  await expect(
    page.getByText("Loading recent history…", { exact: true })
  ).toHaveCount(0);
}

for (const theme of ["dark", "light"]) {
  test(`saved Mac reinstall keeps its host and mirror budget (${theme})`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 1040 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(
      `/?window=dashboard&route=/dashboard/hosts&scenario=hosts-outdated&theme=${theme}&ticks=0`
    );
    await ready(page);
    const card = page.getByRole("region", { name: "studio", exact: true });
    await card.getByRole("button", { name: "Settings for studio" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Size limit", { exact: true }).fill("731");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await card.getByRole("button", { name: /^Reinstall / }).click();
    await expect(
      dialog.getByLabel("LAN SSH alias", { exact: true })
    ).toHaveValue("studio.local");
    await dialog.getByRole("button", { name: "Check connection" }).click();
    const reinstall = dialog.getByRole("button", {
      name: "Reinstall and connect",
    });
    await expect(reinstall).toBeVisible();
    await page.screenshot({
      path: `test-results/screens/hosts-reinstall-${theme}-${info.project.name}.png`,
      animations: "disabled",
    });
    await reinstall.click();
    await expect(dialog).toHaveCount(0);
    await expect(card.getByText(/Latest/)).toBeVisible();
    await expect(
      page.getByRole("region", { name: "studio", exact: true })
    ).toHaveCount(1);
    await card.getByRole("button", { name: "Settings for studio" }).click();
    await expect(dialog.getByLabel("Size limit", { exact: true })).toHaveValue(
      "731"
    );
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(errors).toEqual([]);
  });
  for (const scenario of [
    "hosts-dashboard",
    "rr-jobs",
    "host-updating",
    "host-update-failed",
    "hosts-worst-case",
  ]) {
    test(`Hosts ${scenario} (${theme})`, async ({ page }, info) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width: 1280, height: 1040 });
      if (scenario === "host-updating") {
        const time = new Date("2026-11-10T16:00:00Z");
        await page.clock.install({ time });
        await page.clock.pauseAt(time);
      }
      await page.goto(
        `/?window=dashboard&route=/dashboard/hosts&scenario=${scenario}&theme=${theme}&ticks=0`
      );
      if (scenario === "host-updating") {
        await page.getByRole("progressbar").waitFor({ state: "visible" });
        await page.clock.runFor(4700);
        const progress = page.getByRole("progressbar");
        await expect(progress).toHaveAttribute("aria-valuenow", "4000000");
        await expect(progress).toHaveAttribute("aria-valuemax", "8000000");
      }
      await ready(page);
      if (scenario === "rr-jobs") {
        for (const { name, peer } of [
          { name: "rr-build", peer: "rr-test" },
          { name: "rr-test", peer: "rr-build" },
        ]) {
          const card = page.getByRole("region", { name, exact: true });
          await expect(
            card.getByText("rr running", { exact: true })
          ).toBeVisible();
          await expect(
            card.getByText(`From MacBook Pro · also on ${peer}`, {
              exact: true,
            })
          ).toBeVisible();
        }
        const local = page.getByRole("region", {
          name: "This Mac",
          exact: true,
        });
        await expect(
          local.getByText("cargo check --workspace", { exact: true })
        ).toBeVisible();
        const command = page
          .getByRole("region", { name: "rr-long", exact: true })
          .getByText(/^cargo test --workspace --all-features/);
        await expect(command).toHaveAttribute("tabindex", "0");
        await command.focus();
        await expect(page.getByRole("tooltip")).toContainText(
          "integration_suite_"
        );
        await page.keyboard.press("Escape");
      }
      if (scenario === "hosts-worst-case")
        await expect(
          page.getByText("rr running", { exact: true })
        ).toBeVisible();
      await page.screenshot({
        path: `test-results/screens/hosts-${scenario}-${theme}-${info.project.name}.png`,
        fullPage: true,
        animations: "disabled",
      });
      if (scenario === "host-updating") await page.clock.resume();
      const audit = await new AxeBuilder({ page })
        .include("main")
        .withRules(["color-contrast", "button-name", "aria-progressbar-name"])
        .analyze();
      expect(audit.violations).toEqual([]);
      if (scenario === "rr-jobs") {
        await page.setViewportSize({ width: 700, height: 1040 });
        await page.screenshot({
          path: `test-results/screens/hosts-rr-jobs-narrow-${theme}-${info.project.name}.png`,
          fullPage: true,
          animations: "disabled",
        });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth
          )
        ).toBe(true);
      }
      if (scenario === "hosts-worst-case") {
        const card = page.getByRole("region", {
          name: "production-backup-unreachable-over-the-saved-ssh-alias",
          exact: true,
        });
        await page.setViewportSize({ width: 700, height: 1040 });
        const box = await card.boundingBox();
        if (!box) throw new Error("Missing host card");
        await page.setViewportSize({
          width: Math.round(700 + 400 - box.width),
          height: 1040,
        });
        await expect
          .poll(async () => (await card.boundingBox())?.width)
          .toBe(400);
        const statusIcon = card
          .getByText("Connection failed", { exact: true })
          .locator("..")
          .locator("svg");
        expect(
          await statusIcon.evaluate(
            (icon) => getComputedStyle(icon).strokeWidth
          )
        ).toBe("2px");
        const title = card.getByRole("link", {
          name: "production-backup-unreachable-over-the-saved-ssh-alias",
          exact: true,
        });
        await expect(title.locator("[tabindex]")).toHaveCount(0);
        await title.scrollIntoViewIfNeeded();
        await title.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve())
            )
        );
        await title.focus();
        await expect(page.getByRole("tooltip")).toHaveText(
          "production-backup-unreachable-over-the-saved-ssh-alias"
        );
        await page.keyboard.press("Escape");
        await page.keyboard.press(
          info.project.name === "webkit" ? "Alt+Tab" : "Tab"
        );
        await expect(
          card.getByRole("button", { name: /^Settings for/ })
        ).toBeFocused();
        const text = card.getByText(/^SSH connection failed:/, {
          exact: false,
        });
        await expect(text).toHaveAttribute("tabindex", "0");
        await text.scrollIntoViewIfNeeded();
        // Let the scroll event finish before focus opens Radix's tooltip.
        await text.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve())
            )
        );
        await text.focus();
        await expect(page.getByRole("tooltip")).toContainText(
          "Permission denied (publickey)"
        );
        await page.keyboard.press("Escape");
        await page.screenshot({
          path: `test-results/screens/hosts-worst-case-narrow-${theme}-${info.project.name}.png`,
          fullPage: true,
          animations: "disabled",
        });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth
          )
        ).toBe(true);
      }
      expect(errors).toEqual([]);
    });
  }

  test(`Hosts settings and keyboard actions (${theme})`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 1040 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(
      `/?window=dashboard&route=/dashboard/hosts&scenario=hosts-dashboard&theme=${theme}&ticks=0`
    );
    await ready(page);
    const card = page.getByRole("region", { name: "studio", exact: true });
    await expect(card.getByText("LAN", { exact: true })).not.toHaveAttribute(
      "tabindex",
      "0"
    );
    const name = card.getByRole("link", { name: "studio", exact: true });
    await name.focus();
    await page.keyboard.press(
      info.project.name === "webkit" ? "Alt+Tab" : "Tab"
    );
    await expect(
      card.getByRole("button", { name: "Settings for studio" })
    ).toBeFocused();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    for (const section of [
      "Connection",
      "History on this Mac",
      "Updates on this host",
      "Remove",
    ])
      await expect(
        dialog.getByRole("heading", { name: section, exact: true })
      ).toBeVisible();
    await page.screenshot({
      path: `test-results/screens/hosts-settings-${theme}-${info.project.name}.png`,
      animations: "disabled",
    });
    expect(
      (
        await new AxeBuilder({ page })
          .include('[role="dialog"]')
          .withRules(["color-contrast", "button-name", "label"])
          .analyze()
      ).violations
    ).toEqual([]);
    await dialog.getByLabel("Size limit", { exact: true }).fill("9");
    await expect(
      dialog.getByRole("button", { name: "Save", exact: true })
    ).toBeDisabled();
    await expect(dialog.getByRole("alert")).toContainText("10 to 10,000 MB");
    await dialog.getByLabel("Size limit", { exact: true }).fill("500");
    await dialog
      .getByLabel("LAN SSH alias", { exact: true })
      .fill("ssh invalid");
    await expect(
      dialog.getByRole("button", { name: "Save", exact: true })
    ).toBeDisabled();
    await dialog
      .getByLabel("LAN SSH alias", { exact: true })
      .fill("studio.local");
    await dialog.getByRole("button", { name: "Remove…", exact: true }).click();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const disabled = page.getByRole("region", {
      name: "studio",
      exact: true,
    });
    await disabled
      .getByRole("button", { name: "Turn on", exact: true })
      .click();
    await expect(disabled.getByText("Live", { exact: true })).toBeVisible();
    const offline = page.getByRole("region", { name: "offline", exact: true });
    await offline.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(offline.getByText("Live", { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}
