import { expect, test } from "@playwright/test";

/**
 * The backgrounded engine ticks at 2 s (D-094). A window that opens must see
 * the visible 1 s tick from its first status: if a 2 s status reached it, the
 * popover's 60 s charts would stretch to 120 s for a frame and re-key.
 *
 * The hidden-resume scenario hides the window on the mock's eleventh tick,
 * samples half an hour of 2 s rows and shows it again.
 */
test("the popover reopens on the 1 s tick with its 60 s charts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 760 });
  const start = new Date("2026-11-10T12:00:00Z");
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start.getTime() + 1000);
  // Every CPU chart name the page ever shows, from the first render on.
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __cpuLabels: string[] }).__cpuLabels = seen;
    const record = () => {
      for (const el of document.querySelectorAll("[aria-label^='CPU, last']")) {
        const label = el.getAttribute("aria-label") ?? "";
        if (seen[seen.length - 1] !== label) seen.push(label);
      }
    };
    new MutationObserver(record).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-label"],
    });
  });
  await page.goto("/?window=popover&theme=dark&scenario=hidden-resume");
  // The installed clock replaces the performance entry buffer.
  await page.evaluate(() => {
    const mark = performance.mark.bind(performance);
    performance.mark = (name, options) => {
      if (name === "statglass:resume")
        document.documentElement.dataset.resumed = "";
      return mark(name, options);
    };
  });

  const line = page.locator("[aria-label^='CPU, last'] [data-line]");
  await expect(line).toHaveAttribute("d", /\S/);
  await page.clock.runFor(10_025);
  const beforeResumeLine = (await line.getAttribute("d")) ?? "";
  const html = page.locator("html");
  // Inspect tick eleven before the 50 ms show timer queues catch-up.
  await page.clock.runFor(1000);
  await expect(html).not.toHaveAttribute("data-resumed");
  await expect(line).toHaveAttribute("d", beforeResumeLine);
  await page.clock.runFor(75);
  await expect(html).toHaveAttribute("data-resumed", "");
  await expect(line).not.toHaveAttribute("d", beforeResumeLine);
  const labels = () =>
    page.evaluate(
      () => (window as unknown as { __cpuLabels: string[] }).__cpuLabels
    );
  const atResume = (await labels()).length;

  // Fresh numbers: the CPU line moves on after the resume. (The name holds
  // its figure per 10 s bucket, design-system.md "Accessibility", so it is
  // the line, not the name, that shows each tick.)
  const atResumeLine = (await line.getAttribute("d")) ?? "";
  await page.clock.runFor(1000);
  await expect(line).not.toHaveAttribute("d", atResumeLine);
  expect((await labels()).length).toBeGreaterThanOrEqual(atResume);
  const all = await labels();
  expect(all.length).toBeGreaterThan(0);
  expect(all.filter((l) => !l.startsWith("CPU, last 60 seconds,"))).toEqual([]);
});
