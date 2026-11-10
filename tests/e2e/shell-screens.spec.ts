import { expect, type Page, test } from "@playwright/test";
import { chartsReady } from "./helpers/charts-ready";

/**
 * Popover, dashboard shell, Overview and the plan 4.17 states on the mock
 * transport, in both themes. Screenshots land in test-results/screens/ for
 * the visual review (verification.md); they are not
 * compared against a baseline.
 */
const THEMES = ["light", "dark"] as const;

function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

const shot = async (
  page: Page,
  name: string,
  project: string,
  fullPage = false
) => {
  await chartsReady(page);
  return page.screenshot({
    animations: "disabled",
    path: `test-results/screens/${name}-${project}.png`,
    fullPage,
  });
};

const popoverViewport = (page: Page) =>
  page.locator("[data-radix-scroll-area-viewport]");

for (const theme of THEMES) {
  test(`popover (${theme}) default and scrolled`, async ({ page }, info) => {
    const errors = trackConsoleErrors(page);
    await page.setViewportSize({ width: 360, height: 760 });
    await page.goto(`/?window=popover&theme=${theme}&ticks=0`);
    await expect(page.getByText("Open dashboard")).toBeVisible();
    await expect(page.getByText("Battery", { exact: true })).toBeAttached();
    await shot(page, `popover-${theme}`, info.project.name);
    await popoverViewport(page).evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(page.getByText("Battery", { exact: true })).toBeInViewport();
    await shot(page, `popover-${theme}-scrolled`, info.project.name);
    expect(errors).toEqual([]);
  });

  test(`overview (${theme})`, async ({ page }, info) => {
    const errors = trackConsoleErrors(page);
    await page.setViewportSize({ width: 1280, height: 833 });
    await page.goto(`/?window=dashboard&theme=${theme}&ticks=0`);
    await expect(
      page.getByRole("heading", { name: "Overview", exact: true })
    ).toBeVisible();
    // Process lists fill from the interest the page registers.
    await expect(
      page.getByRole("list", { name: "Top processes by CPU" })
    ).toContainText("Xcode");
    await expect(
      page.getByRole("main").getByRole("link", { name: "Battery", exact: true })
    ).toBeAttached();
    await expect(
      page.getByRole("img", { name: /^Battery charge/ })
    ).toBeAttached();
    await shot(page, `overview-${theme}`, info.project.name);
    expect(errors).toEqual([]);
  });
}

test("overview cards open their module page", async ({ page }) => {
  await page.goto("/?window=dashboard&ticks=0");
  await page
    .getByRole("link", { name: /^Memory/ })
    .last()
    .click();
  await expect(
    page.getByRole("heading", { name: "Memory", exact: true })
  ).toBeVisible();
});

test("a sidebar tab opens its page scrolled to the top", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto("/?window=dashboard&ticks=0");
  await expect(
    page.getByRole("list", { name: "Top processes by CPU" })
  ).toContainText("Xcode");
  const main = page.locator("main");
  await main.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  expect(await main.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await page
    .getByRole("navigation")
    .getByRole("link", { name: /^Network/ })
    .click();
  // The page title, not any "Network" heading: Overview's Network card has
  // one too, which matched before navigation finished. The title and the
  // scroll reset land in the same commit, so one read is enough.
  await expect(
    page.getByRole("heading", { level: 1, name: "Network", exact: true })
  ).toBeVisible();
  expect(await main.evaluate((el) => el.scrollTop)).toBe(0);
});

test("unknown chip hides Power & Sensors and offers the sensor dump", async ({
  page,
}, info) => {
  const errors = trackConsoleErrors(page);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(
    "/?window=dashboard&theme=dark&ticks=0&scenario=unknown-chip"
  );
  await expect(page.getByText(/aren.t mapped for this chip/)).toBeVisible();
  await expect(
    page.getByRole("navigation").getByRole("link", { name: /Power/ })
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation instanceof CSSAnimation &&
                animation.playState === "running"
            ).length
      )
    )
    .toBe(0);
  const noticeGap = await page
    .getByRole("button", { name: "Share sensor dump" })
    .evaluate((button) => {
      const notice = button.closest("p")?.parentElement;
      const previous = notice?.previousElementSibling;
      if (!notice || !previous)
        throw new Error("Missing notice or module grid");
      return (
        notice.getBoundingClientRect().top -
        previous.getBoundingClientRect().bottom
      );
    });
  expect(noticeGap).toBe(16);
  await page.getByRole("button", { name: "Share sensor dump" }).click();
  await expect(page.getByTestId("sensor-dump-json")).toContainText("model");
  await shot(page, "state-unknown-chip-dump", info.project.name);
  await page.keyboard.press("Escape");
  await shot(page, "state-unknown-chip", info.project.name, true);

  await page.setViewportSize({ width: 360, height: 760 });
  await page.goto("/?window=popover&theme=dark&ticks=0&scenario=unknown-chip");
  await expect(page.getByText("Open dashboard")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Network", exact: true })
  ).toBeAttached();
  await expect(
    page.getByRole("heading", { name: "Power", exact: true })
  ).toHaveCount(0);
  await shot(page, "state-unknown-chip-popover", info.project.name);
  expect(errors).toEqual([]);
});

test("no battery and no fans", async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 833 });
  await page.goto("/?window=dashboard&theme=dark&ticks=0&scenario=no-battery");
  await expect(page.getByText("Mac mini (M4 Pro)")).toBeVisible();
  await expect(
    page.getByRole("navigation").getByRole("link", { name: /Battery/ })
  ).toHaveCount(0);
  await expect(
    page.getByRole("main").getByRole("link", { name: "Battery", exact: true })
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Battery", exact: true })
  ).toHaveCount(0);
  await shot(page, "state-no-battery", info.project.name);

  await page.goto("/?window=dashboard&theme=dark&ticks=0&scenario=no-fans");
  await expect(page.getByText("Passive cooling")).toBeVisible();
  await shot(page, "state-no-fans", info.project.name);
});

test("paused and stale", async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 833 });
  await page.goto("/?window=dashboard&theme=dark&ticks=0&scenario=paused");
  await expect(page.getByRole("main").getByText("Paused")).toBeVisible();
  await shot(page, "state-paused", info.project.name);

  // Stale: no frame for three intervals.
  await page.goto("/?window=dashboard&theme=dark&ticks=0&scenario=stale");
  await expect(page.locator("main[data-stale]")).toBeVisible({
    timeout: 6000,
  });
  await expect(page.getByText("Stale · no new data")).toBeVisible();
  await shot(page, "state-stale", info.project.name);

  await page.setViewportSize({ width: 360, height: 760 });
  await page.goto("/?window=popover&theme=dark&ticks=0&scenario=stale");
  await expect(page.getByText("Stale", { exact: true })).toBeVisible({
    timeout: 6000,
  });
  await shot(page, "state-stale-popover", info.project.name);
});

test("fixed-range Overview headers stay aligned at 300 px through live ticks", async ({
  page,
}) => {
  await page.clock.install();
  await page.setViewportSize({ width: 1200, height: 833 });
  await page.goto(
    "/?window=dashboard&theme=dark&chart_window=1h&scenario=network-rate-extremes"
  );
  await page.getByRole("button", { name: /^Time range:/ }).click();
  await page.getByRole("radio", { name: "Date range", exact: true }).click();
  await page
    .getByRole("textbox", { name: "From", exact: true })
    .fill("2026-11-06 12:00");
  await page
    .getByRole("textbox", { name: "To", exact: true })
    .fill("2026-11-06 13:00");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(
    page.getByRole("img", { name: /^CPU total and system, selected dates/ })
  ).toBeVisible();
  await expect(
    page.getByText("Loading chart history…", { exact: true })
  ).toHaveCount(0);
  const network = page
    .getByRole("main")
    .getByRole("link", { name: "Network", exact: true });
  const position = () =>
    network
      .getByRole("img")
      .evaluate((chart) => chart.getBoundingClientRect().top);
  const top = await position();
  const headlines = () =>
    page.locator("main a header").evaluateAll((headers) =>
      headers.map((header) => ({
        height: header.getBoundingClientRect().height,
        overflow: header.scrollWidth > header.clientWidth,
        text: header.textContent,
      }))
    );
  const observed = new Set<string>();
  for (let tick = 0; tick < 16; tick++) {
    await page.clock.runFor(1000);
    const networkText = (await network.textContent()) ?? "";
    if (networkText.includes("↑ 0 B/s ↓ 0 B/s")) observed.add("zero");
    if (networkText.includes("GB/s")) observed.add("large");
    if (networkText.includes("↑ — ↓ —")) observed.add("missing");
    expect(await position()).toBe(top);
    const readings = await headlines();
    expect(readings).toHaveLength(7);
    expect(new Set(readings.map((reading) => reading.height)).size).toBe(1);
    for (const reading of readings) {
      expect(reading.text).toMatch(/ now$/);
      expect(reading.overflow, reading.text ?? "").toBe(false);
    }
  }
  expect([...observed].sort()).toEqual(["large", "missing", "zero"]);
});
