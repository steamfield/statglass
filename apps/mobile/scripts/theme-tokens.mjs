/**
 * Reads the desktop's color tokens out of src/app/styles/theme.css as two
 * resolved maps, one per appearance. Light values come from the top-level
 * `@theme static` block and dark values from the top-level `.dark` rule.
 * Every value is normalized to a hex color React Native can draw, because
 * theme.css uses `oklch()`, `color-mix()` and `var()` that native styles
 * cannot parse.
 */
import { transform } from "lightningcss";
import postcss from "postcss";

const COLOR_PREFIX = "--color-";
const VAR_CALL = /var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)/g;

// Old enough that lightningcss writes every modern color as plain hex first.
const HEX_FALLBACK_TARGETS = { safari: 10 << 16 };

/**
 * @typedef {Record<string, string>} ColorMap token name without `--color-` to color
 * @typedef {{ light: ColorMap, dark: ColorMap }} SchemeColors
 */

/** A problem in the source CSS; the message alone explains it. */
export class ThemeSourceError extends Error {
  /** @override */
  name = "ThemeSourceError";
}

/**
 * The direct `--color-*` declarations of one container, keyed without the prefix.
 * @param {import("postcss").Container} container
 * @returns {ColorMap}
 */
function colorDeclarations(container) {
  /** @type {ColorMap} */
  const colors = {};
  for (const node of container.nodes ?? []) {
    if (node.type === "decl" && node.prop.startsWith(COLOR_PREFIX)) {
      colors[node.prop.slice(COLOR_PREFIX.length)] = node.value.trim();
    }
  }
  return colors;
}

/**
 * The single top-level node `matches` accepts.
 * @param {import("postcss").Root} root
 * @param {(node: import("postcss").ChildNode) => boolean} matches
 * @param {string} label names the block in the error
 * @returns {import("postcss").Container}
 * @throws {ThemeSourceError} when no top-level node matches
 */
function topLevelBlock(root, matches, label) {
  const block = root.nodes.find(matches);
  if (!block)
    throw new ThemeSourceError(`theme.css has no top-level ${label} block`);
  // `matches` only accepts at-rules and rules, which are containers.
  return /** @type {import("postcss").Container} */ (block);
}

/**
 * Replaces every `var(--color-x)` in each value with that token's resolved
 * value from the same map, so a value can mix references with other syntax.
 * @param {ColorMap} colors
 * @param {string} scheme names the appearance in errors
 * @returns {ColorMap}
 * @throws {ThemeSourceError} on a dangling, circular or non-color reference
 */
function resolveReferences(colors, scheme) {
  /** @type {(name: string, chain: string[]) => string} */
  const resolve = (name, chain) => {
    const value = colors[name];
    if (value === undefined) {
      const from = chain.at(-2);
      throw new ThemeSourceError(
        `theme.css ${scheme}: --color-${from} uses var(--color-${name}), which is not defined`
      );
    }
    return value.replace(VAR_CALL, (_call, variable) => {
      if (!variable.startsWith(COLOR_PREFIX)) {
        throw new ThemeSourceError(
          `theme.css ${scheme}: --color-${name} uses ${variable}, which is not a color token`
        );
      }
      const target = variable.slice(COLOR_PREFIX.length);
      if (chain.includes(target)) {
        throw new ThemeSourceError(
          `theme.css ${scheme}: --color-${name} refers back to itself through --color-${target}`
        );
      }
      return resolve(target, [...chain, target]);
    });
  };
  return Object.fromEntries(
    Object.keys(colors).map((name) => [name, resolve(name, [name])])
  );
}

/**
 * One CSS color as hex, through lightningcss's fallback for old targets.
 * @param {string} name token name, for the error
 * @param {string} value any CSS color without `var()`
 * @throws {ThemeSourceError} when lightningcss cannot read the value as a color
 */
export function toHex(name, value) {
  const { code } = transform({
    filename: "theme-token.css",
    code: Buffer.from(`a{color:${value}}`),
    minify: true,
    targets: HEX_FALLBACK_TARGETS,
  });
  const hex = /color:(#[0-9a-f]+)/i.exec(code.toString())?.[1];
  if (!hex) {
    throw new ThemeSourceError(
      `theme.css: --color-${name} "${value}" is not a color`
    );
  }
  return hex.toLowerCase();
}

/** @param {ColorMap} colors */
function toHexMap(colors) {
  return Object.fromEntries(
    Object.entries(colors).map(([name, value]) => [name, toHex(name, value)])
  );
}

/**
 * @param {ColorMap} light
 * @param {ColorMap} darkOverrides
 * @throws {ThemeSourceError} when `.dark` sets a token `@theme static` lacks
 */
function assertDarkOverridesKnown(light, darkOverrides) {
  const darkOnly = Object.keys(darkOverrides).find((name) => !(name in light));
  if (darkOnly) {
    throw new ThemeSourceError(
      `theme.css: --color-${darkOnly} is set in .dark but not in @theme static`
    );
  }
}

/**
 * The light and dark color maps from theme.css source text.
 * @param {string} themeCss
 * @returns {SchemeColors}
 * @throws {ThemeSourceError} when a block is missing, a token is dark-only, a
 *   reference dangles or a value is not a color
 */
export function readSchemeColors(themeCss) {
  const root = postcss.parse(themeCss, { from: "theme.css" });
  const themeBlock = topLevelBlock(
    root,
    (node) =>
      node.type === "atrule" &&
      node.name === "theme" &&
      node.params === "static",
    "@theme static"
  );
  const darkRule = topLevelBlock(
    root,
    (node) => node.type === "rule" && node.selector === ".dark",
    ".dark"
  );
  const light = colorDeclarations(themeBlock);
  const darkOverrides = colorDeclarations(darkRule);
  assertDarkOverridesKnown(light, darkOverrides);
  return {
    light: toHexMap(resolveReferences(light, "light")),
    dark: toHexMap(resolveReferences({ ...light, ...darkOverrides }, "dark")),
  };
}

const NUMBER = /^[+-]?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?$/i;
const DURATION = /^(.*?)(ms|s)$/i;
const NO_PREFERENCE = /^\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)$/;
const REQUIRED_DURATIONS = [
  "--motion-tick",
  "--motion-count",
  "--motion-fast",
  "--motion-entry",
  "--motion-enter",
  "--motion-page",
  "--motion-stagger",
  "--motion-crossfade",
  "--motion-scan",
];

/**
 * @param {Map<string, string>} tokens
 * @param {import('postcss').Container} rule
 * @param {string} prefix
 */
function collectMotionDeclarations(tokens, rule, prefix) {
  for (const decl of rule.nodes ?? []) {
    if (decl.type === "decl" && decl.prop.startsWith(prefix)) {
      tokens.set(decl.prop, decl.value.trim());
    }
  }
}

/** @param {string} name @param {string} value */
function milliseconds(name, value) {
  const [, count = "", unit] = DURATION.exec(value) ?? [];
  const ms = Number(count) * (unit?.toLowerCase() === "s" ? 1000 : 1);
  if (!NUMBER.test(count) || !Number.isFinite(ms) || ms < 0) {
    throw new ThemeSourceError(
      `motion.css: ${name} ${JSON.stringify(value)} is not a duration`
    );
  }
  return ms;
}

/** @param {string} name @param {string} value @returns {[number, number, number, number]} */
function bezier(name, value) {
  const args = /^cubic-bezier\(([^()]*)\)$/i
    .exec(value)?.[1]
    ?.split(",")
    .map((part) => part.trim());
  const [x1 = NaN, y1 = NaN, x2 = NaN, y2 = NaN] = args?.map(Number) ?? [];
  if (
    args?.length !== 4 ||
    !args.every((part) => NUMBER.test(part)) ||
    ![x1, y1, x2, y2].every(Number.isFinite) ||
    x1 < 0 ||
    x1 > 1 ||
    x2 < 0 ||
    x2 > 1
  ) {
    throw new ThemeSourceError(
      `motion.css: ${name} ${JSON.stringify(value)} is not a cubic-bezier curve`
    );
  }
  return [x1, y1, x2, y2];
}

/** @param {string} name */
function camelCase(name) {
  return name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

/** Reads enabled durations and easing curves from desktop motion.css. @param {string} motionCss */
export function readMotionTokens(motionCss) {
  let root;
  try {
    root = postcss.parse(motionCss, { from: "motion.css" });
  } catch (error) {
    if (!(error instanceof postcss.CssSyntaxError)) throw error;
    throw new ThemeSourceError(
      `motion.css:${error.line}:${error.column}: ${error.reason}`
    );
  }
  /** @type {Map<string, string>} */
  const durations = new Map();
  root.walkAtRules("media", (media) => {
    if (media.parent !== root || !NO_PREFERENCE.test(media.params)) return;
    for (const rule of media.nodes ?? []) {
      if (rule.type === "rule" && rule.selector === ":root") {
        collectMotionDeclarations(durations, rule, "--motion-");
      }
    }
  });
  const required = new Set(REQUIRED_DURATIONS);
  root.walkDecls(/^--motion-/, ({ prop }) => {
    required.add(prop);
  });
  for (const name of required) {
    if (!durations.has(name)) {
      throw new ThemeSourceError(
        `motion.css: ${name} is missing in prefers-reduced-motion: no-preference`
      );
    }
  }

  /** @type {Map<string, string>} */
  const easings = new Map();
  root.walkAtRules("theme", (theme) => {
    if (theme.parent === root && theme.params === "static") {
      collectMotionDeclarations(easings, theme, "--ease-");
    }
  });
  for (const name of ["--ease-out", "--ease-tick", "--ease-enter"]) {
    if (!easings.has(name))
      throw new ThemeSourceError(
        `motion.css: ${name} is missing in @theme static`
      );
  }
  return {
    durations: Object.fromEntries(
      Array.from(durations, ([name, value]) => [
        camelCase(name.slice("--motion-".length)),
        milliseconds(name, value),
      ])
    ),
    easings: Object.fromEntries(
      Array.from(easings, ([name, value]) => [
        camelCase(name.slice(2)),
        bezier(name, value),
      ])
    ),
  };
}
