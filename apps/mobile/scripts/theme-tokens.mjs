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

/** A problem in theme.css itself; the message alone explains it. */
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
