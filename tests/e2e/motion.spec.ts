import { expect, type Page, test } from "@playwright/test";
import { chartsReady } from "./helpers/charts-ready";

/**
 * One-shot motion (motion.md "Choreography") on the mock transport with the
 * tick stopped (`ticks=0`), so the only animations are the entrances:
 *
 * - a page's sections lift in on load and again on navigation, and nothing is
 *   left running or stuck invisible afterwards;
 * - under reduced motion nothing animates and everything is visible at once;
 * - Low Power Mode engages Performance mode, which stops all motion.
 */

/** Record CSS entrances and one-shot chart Web Animations from page load on. */
async function recordAnimations(page: Page) {
  await page.addInitScript(() => {
    const names: string[] = [];
    (window as unknown as { __anims: string[] }).__anims = names;
    document.addEventListener("animationstart", (e) => {
      names.push(e.animationName);
      if (/reveal/.test(e.animationName) && e.target instanceof SVGSVGElement)
        e.target.dataset.reveals = String(
          Number(e.target.dataset.reveals ?? 0) + 1
        );
    });
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (keyframes, options) {
      const animation = animate.call(this, keyframes, options);
      if (animation.id === "reveal") {
        names.push("reveal");
        this.setAttribute(
          "data-reveals",
          String(Number(this.getAttribute("data-reveals") ?? 0) + 1)
        );
      }
      return animation;
    };
  });
}

const started = (page: Page) =>
  page.evaluate(() => (window as unknown as { __anims: string[] }).__anims);

/** Every entering element: the route root's children and CardGrid's cells. */
const sectionOpacities = (page: Page) =>
  page.evaluate(() =>
    Array.from(
      document.querySelectorAll("main > div > * > *, main [data-stagger] > *")
    ).map((el) => getComputedStyle(el).opacity)
  );

const running = (page: Page) =>
  page.evaluate(
    () =>
      document.getAnimations().filter((a) => a.playState === "running").length
  );

/** All running motion except the explicitly bounded live-value transitions. */
const unexpectedRunning = (page: Page) =>
  page.evaluate(() => {
    const boundedTick = (effect: KeyframeEffect) => {
      const timing = effect.getTiming();
      return (
        timing.iterations === 1 &&
        typeof timing.duration === "number" &&
        Number.isFinite(timing.duration) &&
        timing.duration > 0 &&
        timing.duration <= 150
      );
    };
    const scrolls = (effect: KeyframeEffect, target: Element) => {
      const frames = effect.getKeyframes();
      // useTickScroll animates only the chart layer's translateX, for one tick token.
      return (
        target.matches("main div[class*='_layer_']") &&
        frames.length === 2 &&
        frames.every(
          (f) =>
            typeof f.transform === "string" &&
            /^translateX\(/.test(f.transform) &&
            Object.keys(f).every((key) =>
              [
                "transform",
                "offset",
                "computedOffset",
                "easing",
                "composite",
              ].includes(key)
            )
        )
      );
    };
    return document
      .getAnimations()
      .filter((a) => a.playState === "running")
      .filter((a) => {
        const effect = a.effect;
        if (
          !(effect instanceof KeyframeEffect) ||
          !(effect.target instanceof Element)
        )
          return true;
        const target = effect.target;
        if (!boundedTick(effect)) return true;
        if (!(a instanceof CSSTransition))
          return a instanceof CSSAnimation || !scrolls(effect, target);
        const declared = getComputedStyle(target).transitionDuration.split(",");
        const ring =
          target.matches("main svg circle") &&
          target.classList.contains(
            "transition-[stroke-dashoffset,transform]"
          ) &&
          ["stroke-dashoffset", "transform"].includes(a.transitionProperty);
        const bar =
          target.matches("main span.origin-left.transition-transform") &&
          a.transitionProperty === "transform";
        return !(
          declared.every((value) => value.trim() === "0.15s") &&
          (ring || bar)
        );
      })
      .map((a) =>
        a instanceof CSSAnimation
          ? a.animationName
          : a instanceof CSSTransition
            ? a.transitionProperty
            : a.constructor.name
      );
  });

const openOverview = async (page: Page) => {
  await page.setViewportSize({ width: 1280, height: 833 });
  await page.goto("/?window=dashboard&theme=dark&ticks=0");
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true })
  ).toBeVisible();
};

async function reverseRing(page: Page, duration: number | null = null) {
  await openOverview(page);
  await page.locator("[data-sidebar-item][href='/dashboard/gpu']").click();
  await expect(
    page.getByRole("heading", { name: "GPU", exact: true })
  ).toBeVisible();
  await expect(
    page
      .locator("main circle.transition-\\[stroke-dashoffset\\,transform\\]")
      .first()
  ).toBeAttached();
  await chartsReady(page);
  await expect.poll(() => running(page), { timeout: 2000 }).toBe(0);
  const original = await page.evaluate(async (duration) => {
    const circle = Array.from(document.querySelectorAll("main circle")).find(
      (el) => el.classList.contains("transition-[stroke-dashoffset,transform]")
    );
    if (!(circle instanceof SVGElement)) throw new Error("No ring circle");
    circle.setAttribute("data-motion-test-ring", "");
    if (duration !== null) circle.style.transitionDuration = `${duration}ms`;
    const original = circle.getAttribute("stroke-dashoffset");
    if (original === null) throw new Error("No ring offset");
    circle.setAttribute("stroke-dashoffset", String(Number(original) + 50));
    getComputedStyle(circle).strokeDashoffset;
    const forward = circle
      .getAnimations()
      .find(
        (a) =>
          a instanceof CSSTransition &&
          a.transitionProperty === "stroke-dashoffset"
      );
    if (!forward) throw new Error("No forward transition");
    forward.pause();
    await forward.ready;
    forward.currentTime = 20;
    getComputedStyle(circle).strokeDashoffset;
    return original;
  }, duration);
  return page.evaluate(async (original) => {
    const circle = document.querySelector("[data-motion-test-ring]");
    if (!circle) throw new Error("No test ring");
    circle.setAttribute("stroke-dashoffset", original);
    getComputedStyle(circle).strokeDashoffset;
    const reversal = circle
      .getAnimations()
      .find(
        (a) =>
          a instanceof CSSTransition &&
          a.transitionProperty === "stroke-dashoffset"
      );
    if (!reversal) throw new Error("No reversal transition");
    // Keep genuine CSS shortening observable across separate browser calls.
    reversal.updatePlaybackRate(0);
    await reversal.ready;
    const duration = reversal.effect?.getTiming().duration;
    if (typeof duration !== "number") throw new Error("No reversal duration");
    return { duration, state: reversal.playState, rate: reversal.playbackRate };
  }, original);
}

test("live-motion validation accepts shortened reversals and rejects long transitions and entrances", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const reversal = await reverseRing(page);
  expect(reversal.state).toBe("running");
  expect(reversal.rate).toBe(0);
  expect(reversal.duration).toBeGreaterThan(0);
  expect(reversal.duration).toBeLessThan(150);
  expect(await unexpectedRunning(page)).toEqual([]);

  await page.evaluate(() => {
    const transition = document
      .querySelector("[data-motion-test-ring]")
      ?.getAnimations()
      .find((a) => a instanceof CSSTransition);
    if (!transition?.effect) throw new Error("No ring transition effect");
    transition.effect.updateTiming({ duration: 400 });
  });
  expect(await unexpectedRunning(page)).toContain("stroke-dashoffset");

  const longDeclared = await reverseRing(page, 400);
  expect(longDeclared.duration).toBeLessThan(150);
  expect(await unexpectedRunning(page)).toContain("stroke-dashoffset");

  await openOverview(page);
  await chartsReady(page);
  await expect.poll(() => running(page), { timeout: 2000 }).toBe(0);
  await page.evaluate(async () => {
    const layer = document.querySelector("main div[class*='_layer_']");
    if (!layer) throw new Error("No chart scroll layer");
    const scroll = layer.animate(
      [{ transform: "translateX(1%)" }, { transform: "translateX(0)" }],
      { duration: 150 }
    );
    scroll.updatePlaybackRate(0);
    await scroll.ready;
  });
  expect(await unexpectedRunning(page)).toEqual([]);
  await page.evaluate(() => {
    const scroll = document
      .querySelector("main div[class*='_layer_']")
      ?.getAnimations()[0];
    if (!scroll?.effect) throw new Error("No scroll animation");
    scroll.effect.updateTiming({ duration: 400 });
  });
  expect(await unexpectedRunning(page)).toContain("Animation");

  await openOverview(page);
  await chartsReady(page);
  await expect.poll(() => running(page), { timeout: 2000 }).toBe(0);
  await page.evaluate(async () => {
    const element = Array.from(
      document.querySelectorAll("main > div > * > *, main [data-stagger] > *")
    ).find((el) => /lift/.test(getComputedStyle(el).animationName));
    if (!(element instanceof HTMLElement))
      throw new Error("No entering element");
    const name = getComputedStyle(element).animationName;
    element.style.animationName = "none";
    getComputedStyle(element).animationName;
    element.style.animationName = name;
    getComputedStyle(element).animationName;
    const entrance = element
      .getAnimations()
      .find((a) => a instanceof CSSAnimation && /lift/.test(a.animationName));
    if (!entrance) throw new Error("No entrance animation");
    entrance.updatePlaybackRate(0);
    await entrance.ready;
  });
  expect(
    (await unexpectedRunning(page)).some((name) => /lift/.test(name))
  ).toBe(true);
});

test("Overview sections and cards lift in, then settle with nothing running", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await recordAnimations(page);
  await openOverview(page);

  await expect
    .poll(
      async () => (await started(page)).filter((n) => /lift/.test(n)).length
    )
    .toBeGreaterThan(6);
  await chartsReady(page);
  await expect.poll(() => running(page), { timeout: 2000 }).toBe(0);
  for (const opacity of await sectionOpacities(page)) expect(opacity).toBe("1");
});

test("navigating replays the page entrance and slides the sidebar pill", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await recordAnimations(page);
  await openOverview(page);
  await chartsReady(page);
  await expect.poll(() => running(page), { timeout: 2000 }).toBe(0);

  const pill = page.locator("[data-sidebar-pill]");
  const before = await pill.evaluate((el) => el.style.transform);
  const liftCount = async () =>
    (await started(page)).filter((n) => /lift/.test(n)).length;
  const lifts = await liftCount();

  await page.locator("[data-sidebar-item][href='/dashboard/cpu']").click();
  await expect(
    page.getByRole("heading", { name: "CPU", exact: true })
  ).toBeVisible();
  await expect.poll(liftCount).toBeGreaterThan(lifts);
  await expect
    .poll(() => pill.evaluate((el) => el.style.transform))
    .not.toBe(before);
  // The first placement snaps with `transition: none`; it must hand the
  // transition back, or every later move would snap too.
  expect(
    await pill.evaluate((el) => getComputedStyle(el).transitionDuration)
  ).not.toBe("0s");
  await chartsReady(page);
  await expect.poll(() => running(page), { timeout: 2000 }).toBe(0);
  for (const opacity of await sectionOpacities(page)) expect(opacity).toBe("1");
});

test("live ticks never replay an entrance", async ({ page }) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await recordAnimations(page);
  await page.setViewportSize({ width: 1280, height: 833 });
  await page.goto("/?window=dashboard&theme=dark");
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true })
  ).toBeVisible();
  await expect
    .poll(
      async () => (await started(page)).filter((n) => /lift/.test(n)).length
    )
    .toBeGreaterThan(0);
  await expect
    .poll(() => unexpectedRunning(page), { timeout: 4000 })
    .toEqual([]);

  await page.evaluate(() => {
    (window as unknown as { __anims: string[] }).__anims.length = 0;
  });
  // Three ticks of fresh values re-render every card.
  await page.clock.runFor(3000);
  expect(
    (await started(page)).filter((n) => /lift|fade|swap|reveal|scan/.test(n))
  ).toEqual([]);
  expect(await unexpectedRunning(page)).toEqual([]);
  for (const opacity of await sectionOpacities(page)) expect(opacity).toBe("1");
});

test("reduced motion: nothing animates and every section is visible at once", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await recordAnimations(page);
  await openOverview(page);

  for (const opacity of await sectionOpacities(page)) expect(opacity).toBe("1");
  await page.locator("[data-sidebar-item][href='/dashboard/cpu']").click();
  await expect(
    page.getByRole("heading", { name: "CPU", exact: true })
  ).toBeVisible();
  for (const opacity of await sectionOpacities(page)) expect(opacity).toBe("1");
  expect(await started(page)).toEqual([]);
});

test("Low Power Mode engages Performance mode and stops all motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1280, height: 833 });
  await page.goto(
    "/?window=dashboard&theme=dark&ticks=0&scenario=low-power-mode"
  );
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true })
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-performance", "");
  const tokens = await page.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
    return {
      tick: s.getPropertyValue("--motion-tick").trim(),
      count: s.getPropertyValue("--motion-count").trim(),
      enter: s.getPropertyValue("--motion-enter").trim(),
      crossfade: s.getPropertyValue("--motion-crossfade").trim(),
    };
  });
  expect(tokens).toEqual({
    tick: "0ms",
    count: "0ms",
    enter: "0ms",
    crossfade: "0ms",
  });
});

test("Overview cards have one animated ancestor and its headers enter separately", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openOverview(page);
  const card = page
    .getByRole("main")
    .getByRole("link", { name: "CPU", exact: true });
  await expect(card).toBeVisible();
  const names = await card.evaluate((card) => {
    const names: string[] = [];
    for (
      let ancestor = card.parentElement;
      ancestor && ancestor.tagName !== "MAIN";
      ancestor = ancestor.parentElement
    ) {
      const name = getComputedStyle(ancestor).animationName;
      if (name !== "none") names.push(name);
    }
    return names;
  });
  expect(names).toHaveLength(1);
  expect(names[0]).toMatch(/lift/);
  const titleMotion = await page
    .getByRole("heading", { name: "Overview", exact: true })
    .evaluate((title) => {
      const header = title.closest("header");
      if (!header) throw new Error("Missing page header");
      return getComputedStyle(header).animationName;
    });
  expect(titleMotion).toMatch(/lift/);
  expect(
    await page
      .getByRole("region", { name: "This Mac" })
      .evaluate((header) => getComputedStyle(header).animationName)
  ).toMatch(/lift/);
});

async function openLoadingCpu(page: Page, scenario = "default") {
  await page.clock.install({ time: new Date("2026-11-10T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-11-10T12:00:01Z"));
  await recordAnimations(page);
  await page.goto(
    `/?route=/dashboard/cpu&theme=dark&ticks=0&scenario=${scenario}`
  );
  await expect(
    page.getByRole("heading", { name: "CPU", exact: true })
  ).toBeVisible();
  await page.clock.runFor(100);
  await expect(page.locator("[data-chart-loading]")).toHaveCount(2);
  await expect(page.locator("path[data-line]")).toHaveCount(0);
  const heat = page.getByRole("img", { name: /^Per-core load/ });
  expect(
    await heat
      .locator("[data-gap]")
      .first()
      .evaluate((cell) => getComputedStyle(cell).backgroundImage)
  ).toBe("none");
}

test("chart backfill scans the baseline, reveals each data svg once, then stops", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openLoadingCpu(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (a) =>
                a.playState === "running" &&
                !(a instanceof CSSAnimation && /scan/.test(a.animationName))
            ).length
      )
    )
    .toBe(0);
  const coreHeader = page.getByRole("heading", { name: /^Per-core load/ });
  const top = await coreHeader.evaluate((el) => el.getBoundingClientRect().top);
  await expect
    .poll(() =>
      page.evaluate(() =>
        document
          .getAnimations()
          .some(
            (a) =>
              a instanceof CSSAnimation &&
              /scan/.test(a.animationName) &&
              a.playState === "running"
          )
      )
    )
    .toBe(true);
  await page.clock.runFor(1100);
  await chartsReady(page);
  const chart = page.getByRole("img", { name: /^CPU total and system/ });
  await expect(chart.locator("path[data-line]")).toHaveCount(2);
  await expect(chart).toHaveAttribute("data-reveals", "1");
  await chartsReady(page);
  await expect.poll(() => running(page), { timeout: 2000 }).toBe(0);
  expect(
    await coreHeader.evaluate((el) => el.getBoundingClientRect().top)
  ).toBe(top);
  await page.clock.runFor(2000);
  await expect(chart).toHaveAttribute("data-reveals", "1");
  const entrances = (await started(page)).filter((name) =>
    /scan|reveal/.test(name)
  );
  await page.evaluate(() => {
    document.documentElement.dataset.navigationLoading = "false";
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (
            node instanceof Element &&
            (node.matches("[data-chart-loading]") ||
              node.querySelector("[data-chart-loading]"))
          ) {
            document.documentElement.dataset.navigationLoading = "true";
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener(
      "navigation-settled",
      () => observer.disconnect(),
      { once: true }
    );
  });
  await page.locator("[data-sidebar-item][href='/dashboard/gpu']").click();
  await expect(
    page.getByRole("heading", { name: "GPU", exact: true })
  ).toBeVisible();
  await page.clock.runFor(100);
  await chartsReady(page);
  await expect.poll(() => running(page), { timeout: 2000 }).toBe(0);
  await page.evaluate(() =>
    document.dispatchEvent(new Event("navigation-settled"))
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-navigation-loading",
    "false"
  );
  expect(
    (await started(page)).filter((name) => /scan|reveal/.test(name))
  ).toEqual(entrances);
});

for (const mode of ["reduced motion", "Performance mode"] as const) {
  test(`chart backfill in ${mode} has no scan or reveal motion`, async ({
    page,
  }) => {
    await page.emulateMedia({
      reducedMotion: mode === "reduced motion" ? "reduce" : "no-preference",
    });
    await openLoadingCpu(
      page,
      mode === "Performance mode" ? "performance-mode" : "default"
    );
    await page.clock.runFor(1100);
    await chartsReady(page);
    await expect(
      page
        .getByRole("img", { name: /^CPU total and system/ })
        .locator("path[data-line]")
    ).toHaveCount(2);
    expect(
      (await started(page)).filter((name) => /scan|reveal/.test(name))
    ).toEqual([]);
    expect(
      await page.evaluate(() =>
        document
          .getAnimations()
          .some(
            (a) =>
              a.id === "reveal" ||
              (a instanceof CSSAnimation && /scan/.test(a.animationName))
          )
      )
    ).toBe(false);
  });
}

test("turning Performance mode off after reveal never replays chart entrances", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openLoadingCpu(page);
  await page.clock.runFor(1600);
  await chartsReady(page);
  const chart = page.getByRole("img", { name: /^CPU total and system/ });
  await expect(chart).toHaveAttribute("data-reveals", "1");
  await expect.poll(() => running(page), { timeout: 2000 }).toBe(0);
  // Exercise the window appearance attribute that native Low Power Mode toggles.
  await page.evaluate(() => {
    document.documentElement.dataset.performance = "";
  });
  await page.clock.runFor(100);
  const before = (await started(page)).filter((n) => /reveal/.test(n));
  await page.evaluate(() => {
    delete document.documentElement.dataset.performance;
  });
  await page.clock.runFor(100);
  expect((await started(page)).filter((n) => /reveal/.test(n))).toEqual(before);
  expect(
    await page.evaluate(() =>
      document
        .getAnimations()
        .some(
          (a) =>
            a.id === "reveal" ||
            (a instanceof CSSAnimation && /reveal/.test(a.animationName))
        )
    )
  ).toBe(false);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.runFor(100);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.clock.runFor(100);
  expect((await started(page)).filter((n) => /reveal/.test(n))).toEqual(before);
});
