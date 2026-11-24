/**
 * Reading the desktop theme into mobile color tokens and rendering the
 * generated files. Plain Node (`node --test`), since the generator runs
 * outside Metro and jest.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderThemeCss } from "../scripts/theme-render.mjs";
import { readSchemeColors } from "../scripts/theme-tokens.mjs";

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

test("fails when the theme has no .dark rule", () => {
  const lightOnly = "@theme static { --color-background: #fafafa; }";

  assert.throws(() => readSchemeColors(lightOnly), /no \.dark block/);
});

test("fails on a reference to a token that does not exist", () => {
  const dangling = `@theme static { --color-a: #000; }
.dark { --color-a: var(--color-missing); }`;

  assert.throws(
    () => readSchemeColors(dangling),
    /dark: var\(--color-missing\) is not defined/
  );
});

test("fails on a value that is not a color", () => {
  const broken = `@theme static { --color-a: 12px; }
.dark { --color-a: #000; }`;

  assert.throws(
    () => readSchemeColors(broken),
    /--color-a "12px" is not a color/
  );
});
