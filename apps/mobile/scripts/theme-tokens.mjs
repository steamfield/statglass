/**
 * Reads the desktop's color tokens out of src/app/styles/theme.css as two
 * resolved maps, one per appearance. Light values come from the `@theme
 * static` block and dark values from the top-level `.dark` rule. Every value
 * is normalized to a hex color React Native can draw, because theme.css uses
 * `oklch()`, `color-mix()` and `var()` that native styles cannot parse.
 */
import { transform } from "lightningcss";

const THEME_BLOCK = /@theme\s+static\s*\{/;
const DARK_BLOCK = /^\.dark\s*\{/m;
const COLOR_DECLARATION = /(--color-[\w-]+)\s*:\s*([^;]+);/g;
const VAR_REFERENCE = /^var\((--color-[\w-]+)\)$/;
const COMMENT = /\/\*[\s\S]*?\*\//g;

// Old enough that lightningcss writes every modern color as plain hex first.
const HEX_FALLBACK_TARGETS = { safari: 10 << 16 };

/**
 * @typedef {Record<string, string>} ColorMap token name without `--color-` to color
 * @typedef {{ light: ColorMap, dark: ColorMap }} SchemeColors
 */

/**
 * The text between the braces of the first block whose opening matches `opener`.
 * @param {string} css
 * @param {RegExp} opener
 * @param {string} label names the block in the error
 */
function blockBody(css, opener, label) {
  const match = opener.exec(css);
  if (!match) throw new Error(`theme.css has no ${label} block`);
  const start = match.index + match[0].length;
  const end = css.indexOf("}", start);
  if (end === -1) throw new Error(`theme.css: ${label} block is not closed`);
  return css.slice(start, end);
}

/**
 * Every `--color-*` declaration in a block body, keyed without the prefix.
 * @param {string} body
 * @returns {ColorMap}
 */
function colorDeclarations(body) {
  const colors = {};
  for (const [, name, value] of body.matchAll(COLOR_DECLARATION)) {
    colors[name.slice("--color-".length)] = value.trim();
  }
  return colors;
}

/**
 * Replaces `var(--color-x)` with the referenced value from the same map.
 * @param {ColorMap} colors
 * @param {string} scheme names the appearance in the error
 * @returns {ColorMap}
 * @throws when a reference names a token the map does not have
 */
function resolveReferences(colors, scheme) {
  const resolve = (name, seen) => {
    const value = colors[name];
    if (value === undefined) {
      throw new Error(
        `theme.css ${scheme}: var(--color-${name}) is not defined`
      );
    }
    const reference = VAR_REFERENCE.exec(value);
    if (!reference) return value;
    const target = reference[1].slice("--color-".length);
    if (seen.has(target)) {
      throw new Error(`theme.css ${scheme}: --color-${name} refers to itself`);
    }
    return resolve(target, new Set([...seen, target]));
  };
  return Object.fromEntries(
    Object.keys(colors).map((name) => [name, resolve(name, new Set([name]))])
  );
}

/**
 * One CSS color as hex, through lightningcss's fallback for old targets.
 * @param {string} name token name, for the error
 * @param {string} value any CSS color
 * @throws when lightningcss cannot parse the value as a color
 */
export function toHex(name, value) {
  const css = `a{color:${value}}`;
  const { code } = transform({
    filename: "theme-token.css",
    code: Buffer.from(css),
    minify: true,
    targets: HEX_FALLBACK_TARGETS,
  });
  const hex = /color:(#[0-9a-f]+)/i.exec(code.toString());
  if (!hex) {
    throw new Error(`theme.css: --color-${name} "${value}" is not a color`);
  }
  return hex[1].toLowerCase();
}

/** @param {ColorMap} colors */
function toHexMap(colors) {
  return Object.fromEntries(
    Object.entries(colors).map(([name, value]) => [name, toHex(name, value)])
  );
}

/**
 * The light and dark color maps from theme.css source text.
 * @param {string} themeCss
 * @returns {SchemeColors}
 * @throws when a block is missing, a reference dangles or a value is not a color
 */
export function readSchemeColors(themeCss) {
  const css = themeCss.replace(COMMENT, "");
  const light = colorDeclarations(blockBody(css, THEME_BLOCK, "@theme static"));
  const darkOverrides = colorDeclarations(blockBody(css, DARK_BLOCK, ".dark"));
  return {
    light: toHexMap(resolveReferences(light, "light")),
    dark: toHexMap(resolveReferences({ ...light, ...darkOverrides }, "dark")),
  };
}
