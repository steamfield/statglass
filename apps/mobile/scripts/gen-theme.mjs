#!/usr/bin/env node
/**
 * Writes theme.generated.css and theme.generated.ts from the desktop's
 * theme.css. With `--check` it writes nothing and exits 1 when either file is
 * missing or differs from what it would write.
 *
 * Usage: gen-theme.mjs [--check] [--source <theme.css>] [--out <dir>]
 * Defaults: src/app/styles/theme.css and apps/mobile/src.
 *
 * NativeWind cannot import theme.css itself: its dark values sit under a
 * `.dark` class and a class-based `dark` variant, which the native compiler
 * rejects in favor of `prefers-color-scheme`.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { renderColorModule, renderThemeCss } from "./theme-render.mjs";
import { readSchemeColors, ThemeSourceError } from "./theme-tokens.mjs";

const appRoot = path.resolve(import.meta.dirname, "..");
const DEFAULT_SOURCE = path.resolve(appRoot, "../../src/app/styles/theme.css");
const DEFAULT_OUT = path.join(appRoot, "src");

/** A stale or missing generated file; the message names it. */
class StaleThemeError extends Error {
  /** @override */
  name = "StaleThemeError";
}

/**
 * @param {string} source theme.css text
 * @param {string} outDir
 */
function outputsFor(source, outDir) {
  const schemes = readSchemeColors(source);
  return [
    {
      file: path.join(outDir, "theme.generated.css"),
      text: renderThemeCss(schemes),
    },
    {
      file: path.join(outDir, "theme.generated.ts"),
      text: renderColorModule(schemes),
    },
  ];
}

/** @param {string} file */
async function readIfPresent(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

/**
 * @param {{ file: string, text: string }[]} outputs
 * @returns {Promise<string[]>} the files that are missing or differ
 */
async function staleFiles(outputs) {
  const stale = [];
  for (const { file, text } of outputs) {
    if ((await readIfPresent(file)) !== text)
      stale.push(path.relative(process.cwd(), file));
  }
  return stale;
}

async function main() {
  const { values } = parseArgs({
    options: {
      check: { type: "boolean", default: false },
      source: { type: "string", default: DEFAULT_SOURCE },
      out: { type: "string", default: DEFAULT_OUT },
    },
  });
  const outputs = outputsFor(await readFile(values.source, "utf8"), values.out);
  if (!values.check) {
    await Promise.all(outputs.map(({ file, text }) => writeFile(file, text)));
    return;
  }
  const stale = await staleFiles(outputs);
  if (stale.length > 0) {
    throw new StaleThemeError(
      `mobile theme is missing or out of date with ${path.relative(process.cwd(), values.source)}: ${stale.join(", ")}. ` +
        "Run `node apps/mobile/scripts/gen-theme.mjs` and commit the result."
    );
  }
}

main().catch((error) => {
  const known =
    error instanceof ThemeSourceError || error instanceof StaleThemeError;
  console.error(`gen-theme: ${known ? error.message : error.stack}`);
  process.exitCode = 1;
});
