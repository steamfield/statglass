/**
 * Reading the desktop theme into mobile color tokens and rendering the
 * generated files. Plain Node (`node --test`), since the generator runs
 * outside Metro and jest.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderThemeCss } from "../scripts/theme-render.mjs";
import {
  readMotionTokens,
  readSchemeColors,
} from "../scripts/theme-tokens.mjs";
import { MOTION } from "./motion-css-fixture.mjs";

const THEME = `
@custom-variant dark (&:where(.dark, .dark *));
@theme static {
  --font-sans: -apple-system;
  /* --color-commented: #123456; */
  --color-background: #fafafa;
  --color-card: rgba(255, 255, 255, 0.72);
  --color-destructive: oklch(57.7% 0.245 27.33);
  --color-cpu: #06b6d4;
  --color-cpu-ink: #0891b2;
}
.dark {
  --color-background: #09090b;
  --color-card: color-mix(in srgb, #111113 72%, transparent);
  --color-cpu-ink: var(--color-cpu);
}
.dark .surface-vibrant {
  --color-background: #ff0000;
}
`;

test("reads light from @theme and dark as light plus the .dark overrides", () => {
  assert.deepEqual(readSchemeColors(THEME), {
    light: {
      background: "#fafafa",
      card: "#ffffffb8",
      destructive: "#e40014",
      cpu: "#06b6d4",
      "cpu-ink": "#0891b2",
    },
    dark: {
      background: "#09090b",
      card: "#111113b8",
      destructive: "#e40014",
      cpu: "#06b6d4",
      "cpu-ink": "#06b6d4",
    },
  });
});

test("puts only the values that change in the dark media block", () => {
  const css = renderThemeCss(readSchemeColors(THEME));
  const dark = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));

  assert.match(css, /@theme \{\n {2}--color-background: #fafafa;/);
  assert.deepEqual(dark.match(/--color-[\w-]+/g), [
    "--color-background",
    "--color-card",
    "--color-cpu-ink",
  ]);
});

test("resolves references nested inside another color function", () => {
  const mixed = `@theme static {
  --color-cpu: #06b6d4;
  --color-glow: color-mix(in srgb, var(--color-cpu) 50%, transparent);
}
.dark { --color-cpu: #000000; }`;

  const { light, dark } = readSchemeColors(mixed);

  assert.equal(light.glow, "#06b6d480");
  assert.equal(dark.glow, "#00000080");
});

const FAILURES = [
  {
    name: "a theme without a .dark rule",
    css: "@theme static { --color-background: #fafafa; }",
    message: "theme.css has no top-level .dark block",
  },
  {
    name: "a .dark rule nested inside another block",
    css: `@theme static { --color-a: #000; }
@media (prefers-contrast: more) { .dark { --color-a: #fff; } }`,
    message: "theme.css has no top-level .dark block",
  },
  {
    name: "a token set in .dark only",
    css: `@theme static { --color-a: #000; }
.dark { --color-b: #fff; }`,
    message: "theme.css: --color-b is set in .dark but not in @theme static",
  },
  {
    name: "a reference to a token that does not exist",
    css: `@theme static { --color-a: #000; }
.dark { --color-a: var(--color-missing); }`,
    message:
      "theme.css dark: --color-a uses var(--color-missing), which is not defined",
  },
  {
    name: "a reference to a variable that is not a color token",
    css: `@theme static { --color-a: color-mix(in srgb, #000 var(--ramp-2), transparent); }
.dark { --color-a: #000; }`,
    message:
      "theme.css light: --color-a uses --ramp-2, which is not a color token",
  },
  {
    name: "two tokens that refer to each other",
    css: `@theme static { --color-a: var(--color-b); --color-b: var(--color-a); }
.dark { --color-a: #000; }`,
    message:
      "theme.css light: --color-b refers back to itself through --color-a",
  },
  {
    name: "a value that is not a color",
    css: `@theme static { --color-a: 12px; }
.dark { --color-a: #000; }`,
    message: 'theme.css: --color-a "12px" is not a color',
  },
];

for (const failure of FAILURES) {
  test(`fails on ${failure.name}`, () => {
    assert.throws(() => readSchemeColors(failure.css), {
      name: "ThemeSourceError",
      message: failure.message,
    });
  });
}

test("reads enabled motion durations in ms and easing curves as control points", () => {
  assert.deepEqual(readMotionTokens(MOTION), {
    durations: {
      tick: 175,
      count: 450,
      fast: 150,
      entry: 300,
      enter: 280,
      page: 400,
      stagger: 40,
      crossfade: 150,
      scan: 800,
      extraDelay: 9.5,
    },
    easings: {
      easeOut: [0.16, 1, 0.3, 1],
      easeTick: [0.33, 1, 0.68, 1],
      easeEnter: [0.25, 1, 0.5, 1],
    },
  });
});

test("reports a duration missing from the no-preference rule", () => {
  assert.throws(
    () => readMotionTokens(MOTION.replace("--motion-tick: 175ms;", "")),
    {
      name: "ThemeSourceError",
      message:
        "motion.css: --motion-tick is missing in prefers-reduced-motion: no-preference",
    }
  );
});

test("reports a duration declared only for Performance mode", () => {
  const css = MOTION.replace("--motion-tick: 0ms;", "").replace(
    "--motion-tick: 175ms;",
    ""
  );
  assert.throws(() => readMotionTokens(css), {
    name: "ThemeSourceError",
    message:
      "motion.css: --motion-tick is missing in prefers-reduced-motion: no-preference",
  });
});

test("reports a required duration removed from the entire source", () => {
  assert.throws(
    () => readMotionTokens(MOTION.replaceAll(/--motion-count: [^;]+;/g, "")),
    {
      name: "ThemeSourceError",
      message:
        "motion.css: --motion-count is missing in prefers-reduced-motion: no-preference",
    }
  );
});

test("uses later overrides both within and across no-preference blocks", () => {
  const css = `${MOTION}
@media (prefers-reduced-motion: no-preference) {
  :root { --motion-tick: 140ms; }
  :root { --motion-tick: 130ms; }
}`;
  assert.equal(readMotionTokens(css).durations.tick, 130);
});

test("reports a missing easing curve", () => {
  assert.throws(
    () =>
      readMotionTokens(
        MOTION.replace("--ease-tick: cubic-bezier(0.33, 1, 0.68, 1);", "")
      ),
    {
      name: "ThemeSourceError",
      message: "motion.css: --ease-tick is missing in @theme static",
    }
  );
});

test("rejects a duration with the wrong unit", () => {
  assert.throws(() => readMotionTokens(MOTION.replace("175ms", "175px")), {
    name: "ThemeSourceError",
    message: 'motion.css: --motion-tick "175px" is not a duration',
  });
});

for (const curve of [
  "cubic-bezier(.33, 1, .68)",
  "cubic-bezier(1.1, 1, .68, 1)",
  "cubic-bezier(.33, , .68, 1)",
]) {
  test(`rejects ${curve} as an easing curve`, () => {
    assert.throws(
      () =>
        readMotionTokens(
          MOTION.replace("cubic-bezier(0.33, 1, 0.68, 1)", curve)
        ),
      {
        name: "ThemeSourceError",
        message: `motion.css: --ease-tick "${curve}" is not a cubic-bezier curve`,
      }
    );
  });
}
